import { getAccountsByEmail, getHistoryId, putHistoryId } from "@db/accounts";
import { EmailProvider } from "@providers/base";
import { getAccessToken, gmailGet, gmailPost } from "@providers/gmail/utils";
import { base64urlToArrayBuffer, base64urlToString } from "@utils/base64url";
import { wrapPlainText } from "@utils/format";
import { HTTPError } from "ky";
import {
  GMAIL_MODIFY_SCOPE,
  GOOGLE_OAUTH_AUTHORIZE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
} from "@/constants";
import type { Env, MailMeta } from "@/types";

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPayload[];
}

interface GmailMessage {
  id: string;
  labelIds?: string[];
  payload?: GmailPayload;
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

export interface FetchMailResult {
  html: string;
  cidMap: Map<string, string>;
  meta: MailMeta;
}

export class GmailProvider extends EmailProvider {
  static oauth = EmailProvider.createOAuthHandler({
    name: "Google",
    authorizeUrl: GOOGLE_OAUTH_AUTHORIZE_URL,
    tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
    scope: GMAIL_MODIFY_SCOPE,
    statePrefix: "",
    extraAuthorizeParams: {
      access_type: "offline",
      include_granted_scopes: "true",
    },
    getCredentials: (env) => ({
      clientId: env.GMAIL_CLIENT_ID,
      clientSecret: env.GMAIL_CLIENT_SECRET,
    }),
    fetchEmail: async (accessToken) => {
      const profile = await gmailGet<{ emailAddress?: string }>(
        accessToken,
        "/users/me/profile",
      );
      return profile.emailAddress;
    },
    onAuthorized: async (env, account) => {
      const provider = new GmailProvider(account, env);
      await provider.renewPush();
      console.log(`Auto-watch activated for ${account.email}`);
    },
  });

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

  // ─── 邮件正文获取 ──────────────────────────────────────────────────────

  /** 获取原始 MIME 邮件内容（Gmail API format=raw，返回 ArrayBuffer） */
  async fetchRawEmail(messageId: string): Promise<ArrayBuffer> {
    const token = await this.token();
    const msg = await gmailGet<{ raw: string }>(
      token,
      `/users/me/messages/${messageId}?format=raw`,
    );
    return base64urlToArrayBuffer(msg.raw);
  }

  /** 从 Gmail API 获取邮件正文 HTML，优先 HTML，fallback 到纯文本 */
  async fetchMailContent(messageId: string): Promise<FetchMailResult | null> {
    const token = await this.token();
    const msg = await gmailGet<{ payload: GmailPayload }>(
      token,
      `/users/me/messages/${messageId}?format=full`,
    );
    const meta: MailMeta = {
      subject: extractHeader(msg.payload, "subject"),
      from: extractHeader(msg.payload, "from"),
      to: extractHeader(msg.payload, "to"),
      date: extractHeader(msg.payload, "date"),
    };
    const html = extractPartByMime(msg.payload, "text/html");

    const cidMap = new Map<string, string>();
    collectInlineParts(msg.payload, cidMap);

    // 需要通过附件 API 获取的内联图片
    const pending: { cid: string; mimeType: string; attachmentId: string }[] =
      [];
    collectInlineAttachmentIds(msg.payload, pending);
    if (pending.length > 0) {
      await Promise.all(
        pending.map(async ({ cid, mimeType, attachmentId }) => {
          const att = await gmailGet<{ data?: string }>(
            token,
            `/users/me/messages/${messageId}/attachments/${attachmentId}`,
          );
          if (att.data) {
            // Gmail 返回的是 base64url，转为标准 base64
            const b64 = att.data.replace(/-/g, "+").replace(/_/g, "/");
            cidMap.set(cid, `data:${mimeType};base64,${b64}`);
          }
        }),
      );
    }

    if (html) return { html, cidMap, meta };

    const plain = extractPartByMime(msg.payload, "text/plain");
    if (plain) return { html: wrapPlainText(plain), cidMap, meta };

    return null;
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

  async moveToInbox(messageId: string): Promise<string> {
    await gmailPost(
      await this.token(),
      `/users/me/messages/${messageId}/modify`,
      {
        addLabelIds: ["INBOX"],
        removeLabelIds: ["SPAM"],
      },
    );
    return messageId;
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

// ─── Gmail payload 解析 helpers ──────────────────────────────────────────────

/** 从 Gmail payload headers 中提取指定头部 */
function extractHeader(payload: GmailPayload, name: string): string | null {
  return (
    payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
      ?.value ?? null
  );
}

/** 递归收集内联图片（body.data 已内嵌的情况） */
function collectInlineParts(
  payload: GmailPayload,
  cidMap: Map<string, string>,
): void {
  if (!payload) return;
  const contentId = payload.headers?.find(
    (h) => h.name.toLowerCase() === "content-id",
  )?.value;
  if (
    contentId &&
    payload.body?.data &&
    payload.mimeType?.startsWith("image/")
  ) {
    const cid = contentId.replace(/^<|>$/g, "");
    const b64 = payload.body.data.replace(/-/g, "+").replace(/_/g, "/");
    cidMap.set(cid, `data:${payload.mimeType};base64,${b64}`);
  }
  if (payload.parts) {
    for (const part of payload.parts) collectInlineParts(part, cidMap);
  }
}

/** 递归收集需要通过附件 API 获取的内联图片 */
function collectInlineAttachmentIds(
  payload: GmailPayload,
  result: { cid: string; mimeType: string; attachmentId: string }[],
): void {
  if (!payload) return;
  const contentId = payload.headers?.find(
    (h) => h.name.toLowerCase() === "content-id",
  )?.value;
  if (
    contentId &&
    !payload.body?.data &&
    payload.body?.attachmentId &&
    payload.mimeType?.startsWith("image/")
  ) {
    result.push({
      cid: contentId.replace(/^<|>$/g, ""),
      mimeType: payload.mimeType,
      attachmentId: payload.body.attachmentId,
    });
  }
  if (payload.parts) {
    for (const part of payload.parts) collectInlineAttachmentIds(part, result);
  }
}

/** 递归提取 payload 中指定 MIME 类型的内容 */
function extractPartByMime(
  payload: GmailPayload,
  mimeType: string,
): string | null {
  if (!payload) return null;

  if (payload.mimeType === mimeType && payload.body?.data) {
    return base64urlToString(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const content = extractPartByMime(part, mimeType);
      if (content) return content;
    }
  }

  return null;
}
