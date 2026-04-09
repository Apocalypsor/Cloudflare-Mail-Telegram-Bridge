import { getAccountsByEmail, getHistoryId, putHistoryId } from "@db/accounts";
import {
  getAccessToken,
  gmailGet,
  gmailPost,
} from "@services/email/gmail/utils";
import { EmailProvider } from "@services/email/provider";
import { HTTPError } from "ky";
import type { Env } from "@/types";

export { getAccessToken, gmailGet } from "@services/email/gmail/utils";

interface GmailMessage {
  id: string;
  labelIds?: string[];
  payload?: { headers?: { name: string; value: string }[] };
}

interface GmailMessageList {
  messages?: { id: string }[];
}

interface GmailWatchResponse {
  historyId?: string;
  expiration?: string;
}

interface GmailHistoryResponse {
  history?: {
    messagesAdded?: { message: GmailMessage }[];
  }[];
  historyId?: string;
  nextPageToken?: string;
}

interface GmailProfile {
  historyId: string;
}

export class GmailProvider extends EmailProvider {
  private async token(): Promise<string> {
    return getAccessToken(this.env, this.account);
  }

  // ─── Enqueue ──────────────────────────────────────────────────────────

  /** 解析 Pub/Sub 通知，获取新邮件列表并入队 */
  static async enqueue(
    body: { message: { data: string } },
    env: Env,
  ): Promise<void> {
    const decoded = JSON.parse(atob(body.message.data)) as {
      emailAddress: string;
      historyId: string;
    };
    console.log(
      `Pub/Sub notification: email=${decoded.emailAddress}, historyId=${decoded.historyId}`,
    );

    const accounts = await getAccountsByEmail(env.DB, decoded.emailAddress);
    if (accounts.length === 0) {
      console.log(`No account found for ${decoded.emailAddress}, skipping`);
      return;
    }

    for (const account of accounts) {
      const storedHistoryId = await getHistoryId(env.DB, account.id);
      if (!storedHistoryId) {
        await putHistoryId(env.DB, account.id, decoded.historyId);
        console.log(
          `Initialized historyId for ${account.email} (#${account.id}):`,
          decoded.historyId,
        );
        continue;
      }

      const provider = new GmailProvider(account, env);
      const messageIds = await provider.fetchNewMessageIds();
      if (messageIds.length === 0) {
        console.log(`No new messages for ${account.email} (#${account.id})`);
        continue;
      }

      console.log(
        `Found ${messageIds.length} new messages for ${account.email} (#${account.id}), enqueueing`,
      );
      await env.EMAIL_QUEUE.sendBatch(
        messageIds.map((id) => ({
          body: { accountId: account.id, messageId: id },
        })),
      );
    }
  }

  // ─── Push (Gmail Watch) ─────────────────────────────────────────────────

  async renewPush() {
    const token = await this.token();
    const result = await gmailPost<GmailWatchResponse>(
      token,
      "/users/me/watch",
      {
        topicName: this.env.GMAIL_PUBSUB_TOPIC,
        labelIds: ["INBOX"],
      },
    );
    if (!result?.historyId) {
      throw new Error(
        `Gmail watch returned no historyId for ${this.account.email}`,
      );
    }
    console.log(
      `Gmail watch renewed for ${this.account.email}, historyId:`,
      result.historyId,
      "expiration:",
      result.expiration,
    );

    const existing = await getHistoryId(this.env.DB, this.account.id);
    if (!existing) {
      await putHistoryId(
        this.env.DB,
        this.account.id,
        String(result.historyId),
      );
    }
  }

  async stopPush() {
    await gmailPost(await this.token(), "/users/me/stop", {});
    console.log(`Gmail watch stopped for ${this.account.email}`);
  }

  // ─── History / 新邮件拉取 ──────────────────────────────────────────────

  /** 拉取自上次 historyId 以来的新 INBOX 消息 ID 列表 */
  async fetchNewMessageIds(): Promise<string[]> {
    const storedHistoryId = await getHistoryId(this.env.DB, this.account.id);
    if (!storedHistoryId) return [];

    const token = await this.token();
    const messageIds = new Set<string>();
    let pageToken: string | undefined;
    let latestHistoryId: string | undefined;

    do {
      let path = `/users/me/history?startHistoryId=${storedHistoryId}&historyTypes=messageAdded&labelId=INBOX`;
      if (pageToken) path += `&pageToken=${pageToken}`;

      let history: GmailHistoryResponse;
      try {
        history = await gmailGet<GmailHistoryResponse>(token, path);
      } catch (err) {
        if (err instanceof HTTPError && err.response.status === 404) {
          console.warn(
            `historyId expired for ${this.account.email}, resetting`,
          );
          const profile = await gmailGet<GmailProfile>(
            token,
            "/users/me/profile",
          );
          await putHistoryId(this.env.DB, this.account.id, profile.historyId);
          return [];
        }
        throw err;
      }

      if (history.history) {
        for (const h of history.history) {
          if (h.messagesAdded) {
            for (const added of h.messagesAdded) {
              if (added.message?.labelIds?.includes("INBOX")) {
                messageIds.add(added.message.id);
              }
            }
          }
        }
      }

      pageToken = history.nextPageToken;
      if (history.historyId) {
        latestHistoryId = String(history.historyId);
      }
    } while (pageToken);

    if (latestHistoryId) {
      await putHistoryId(this.env.DB, this.account.id, latestHistoryId);
    }

    return [...messageIds];
  }

  // ─── Message actions ──────────────────────────────────────────────────

  async markAsRead(messageId: string) {
    await gmailPost(
      await this.token(),
      `/users/me/messages/${messageId}/modify`,
      {
        removeLabelIds: ["UNREAD"],
      },
    );
  }

  async addStar(messageId: string) {
    await gmailPost(
      await this.token(),
      `/users/me/messages/${messageId}/modify`,
      {
        addLabelIds: ["STARRED"],
      },
    );
  }

  async removeStar(messageId: string) {
    await gmailPost(
      await this.token(),
      `/users/me/messages/${messageId}/modify`,
      {
        removeLabelIds: ["STARRED"],
      },
    );
  }

  async isStarred(messageId: string) {
    const msg = await gmailGet<GmailMessage>(
      await this.token(),
      `/users/me/messages/${messageId}?format=MINIMAL`,
    );
    return msg.labelIds?.includes("STARRED") ?? false;
  }

  async isJunk(messageId: string) {
    const msg = await gmailGet<GmailMessage>(
      await this.token(),
      `/users/me/messages/${messageId}?format=MINIMAL`,
    );
    return msg.labelIds?.includes("SPAM") ?? false;
  }

  async listUnread(maxResults: number = 20) {
    const token = await this.token();
    return this.listByQuery(token, `is:unread`, maxResults);
  }

  async listStarred(maxResults: number = 20) {
    const token = await this.token();
    return this.listByQuery(token, `is:starred`, maxResults);
  }

  async listJunk(maxResults: number = 20) {
    const token = await this.token();
    return this.listByQuery(token, `in:spam`, maxResults);
  }

  async markAsJunk(messageId: string) {
    await gmailPost(
      await this.token(),
      `/users/me/messages/${messageId}/modify`,
      {
        addLabelIds: ["SPAM"],
        removeLabelIds: ["INBOX"],
      },
    );
  }

  async moveToInbox(messageId: string) {
    await gmailPost(
      await this.token(),
      `/users/me/messages/${messageId}/modify`,
      {
        addLabelIds: ["INBOX"],
        removeLabelIds: ["SPAM"],
      },
    );
  }

  async trashMessage(messageId: string) {
    await gmailPost(
      await this.token(),
      `/users/me/messages/${messageId}/trash`,
      {},
    );
  }

  async trashAllJunk() {
    const token = await this.token();
    const data = await gmailGet<GmailMessageList>(
      token,
      "/users/me/messages?q=in:spam&maxResults=100",
    );
    if (!data.messages) return 0;
    const ids = data.messages.map((m) => m.id);
    await gmailPost(token, "/users/me/messages/batchModify", {
      ids,
      addLabelIds: ["TRASH"],
      removeLabelIds: ["SPAM"],
    });
    return ids.length;
  }

  private async listByQuery(token: string, query: string, maxResults: number) {
    const data = await gmailGet<GmailMessageList>(
      token,
      `/users/me/messages?q=${query}&maxResults=${maxResults}`,
    );
    if (!data.messages) return [];
    return Promise.all(
      data.messages.map(async ({ id }) => {
        try {
          const msg = await gmailGet<GmailMessage>(
            token,
            `/users/me/messages/${id}?format=METADATA&metadataHeaders=Subject`,
          );
          const subjectHeader = msg.payload?.headers?.find(
            (h) => h.name.toLowerCase() === "subject",
          );
          return { id, subject: subjectHeader?.value };
        } catch {
          return { id };
        }
      }),
    );
  }
}
