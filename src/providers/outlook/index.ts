import { getAccountById } from "@db/accounts";
import {
  deleteMsSubscription,
  getMsAccountBySubscription,
  getMsSubscriptionId,
  putMsSubscription,
  refreshMsSubAccountMapping,
} from "@db/kv";
import {
  ROUTE_OAUTH_MICROSOFT_CALLBACK,
  ROUTE_OAUTH_MICROSOFT_START,
} from "@handlers/hono/routes";
import { EmailProvider } from "@providers/base";
import {
  fetchRawMime,
  getAccessToken,
  graphGet,
  graphPatch,
  graphPost,
} from "@providers/outlook/utils";
import { http } from "@utils/http";
import { reportErrorToObservability } from "@utils/observability";
import { HTTPError } from "ky";
import {
  MS_GRAPH_API,
  MS_GRAPH_API_BETA,
  MS_MAIL_SCOPE,
  MS_OAUTH_AUTHORIZE_URL,
  MS_OAUTH_TOKEN_URL,
  MS_SUBSCRIPTION_LIFETIME_MINUTES,
} from "@/constants";
import type { Env } from "@/types";

interface GraphMessage {
  id: string;
  subject?: string;
  parentFolderId?: string;
  flag?: { flagStatus: string };
}

interface GraphMessageList {
  value?: GraphMessage[];
}

interface GraphFolder {
  id: string;
}

export class OutlookProvider extends EmailProvider {
  static oauth = EmailProvider.createOAuthHandler({
    name: "Microsoft",
    authorizeUrl: MS_OAUTH_AUTHORIZE_URL,
    tokenUrl: MS_OAUTH_TOKEN_URL,
    scope: MS_MAIL_SCOPE,
    startRoute: ROUTE_OAUTH_MICROSOFT_START,
    callbackRoute: ROUTE_OAUTH_MICROSOFT_CALLBACK,
    statePrefix: "ms:",
    extraAuthorizeParams: { response_mode: "query" },
    getCredentials: (env) => ({
      clientId: env.MS_CLIENT_ID as string,
      clientSecret: env.MS_CLIENT_SECRET as string,
    }),
    extraTokenBody: () => ({ scope: MS_MAIL_SCOPE }),
    fetchEmail: async (accessToken) => {
      const profile = await graphGet<{
        mail?: string;
        userPrincipalName?: string;
      }>(accessToken, "/me");
      return profile.mail || profile.userPrincipalName;
    },
    onAuthorized: async (env, account) => {
      const provider = new OutlookProvider(account, env);
      await provider.renewPush();
      console.log(`Outlook subscription activated for ${account.email}`);
    },
  });

  private async token(): Promise<string> {
    return getAccessToken(this.env, this.account);
  }

  // ─── Enqueue ──────────────────────────────────────────────────────────

  /** 解析 Graph change notification 并入队 */
  static async enqueue(
    body: {
      value: Array<{
        subscriptionId: string;
        changeType: string;
        resource: string;
        resourceData?: { id: string };
        clientState?: string;
      }>;
    },
    env: Env,
  ): Promise<void> {
    const batch: Array<{ body: { accountId: number; messageId: string } }> = [];

    for (const notification of body.value) {
      if (notification.clientState !== env.MS_WEBHOOK_SECRET) {
        console.log("Outlook push: invalid clientState, skipping");
        continue;
      }

      const messageId = notification.resourceData?.id;
      if (!messageId) {
        console.log("Outlook push: no resourceData.id, skipping");
        continue;
      }

      const accountIdStr = await getMsAccountBySubscription(
        env.EMAIL_KV,
        notification.subscriptionId,
      );
      if (!accountIdStr) {
        console.log(
          `Outlook push: unknown subscriptionId ${notification.subscriptionId}`,
        );
        continue;
      }

      const accountId = parseInt(accountIdStr, 10);
      const account = await getAccountById(env.DB, accountId);
      if (!account) {
        console.log(`Outlook push: account ${accountId} not found`);
        continue;
      }

      batch.push({ body: { accountId: account.id, messageId } });
    }

    if (batch.length > 0) {
      console.log(`Outlook push: enqueueing ${batch.length} messages`);
      await env.EMAIL_QUEUE.sendBatch(batch);
    }
  }

  // ─── Push (Outlook Subscription) ──────────────────────────────────────

  async renewPush() {
    if (!this.env.MS_WEBHOOK_SECRET) {
      throw new Error("MS_WEBHOOK_SECRET not configured");
    }
    const token = await this.token();
    const workerUrl = this.env.WORKER_URL?.replace(/\/$/, "") || "";
    const notificationUrl = `${workerUrl}/api/outlook/push?secret=${this.env.MS_WEBHOOK_SECRET}`;

    const expiration = new Date(
      Date.now() + MS_SUBSCRIPTION_LIFETIME_MINUTES * 60 * 1000,
    ).toISOString();

    const ttl = MS_SUBSCRIPTION_LIFETIME_MINUTES * 60;

    const existingSubId = await getMsSubscriptionId(
      this.env.EMAIL_KV,
      this.account.id,
    );

    if (existingSubId) {
      try {
        const resp = await http.patch(
          `${MS_GRAPH_API}/subscriptions/${existingSubId}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            json: { expirationDateTime: expiration },
            throwHttpErrors: false,
          },
        );
        if (resp.ok) {
          await refreshMsSubAccountMapping(
            this.env.EMAIL_KV,
            existingSubId,
            this.account.id,
            ttl,
          );
          console.log(`Outlook subscription renewed for ${this.account.email}`);
          return;
        }
      } catch {
        // 续订失败，创建新的
      }
    }

    let sub: { id: string };
    try {
      sub = (await http
        .post(`${MS_GRAPH_API}/subscriptions`, {
          headers: { Authorization: `Bearer ${token}` },
          json: {
            changeType: "created",
            notificationUrl,
            resource: "me/mailFolders('Inbox')/messages",
            expirationDateTime: expiration,
            clientState: this.env.MS_WEBHOOK_SECRET,
          },
        })
        .json()) as { id: string };
    } catch (err) {
      if (err instanceof HTTPError) {
        const text = await err.response.text();
        throw new Error(
          `Failed to create Graph subscription for ${this.account.email}: ${err.response.status} ${text}`,
        );
      }
      throw err;
    }
    await putMsSubscription(this.env.EMAIL_KV, this.account.id, sub.id, ttl);
    console.log(
      `Outlook subscription created for ${this.account.email}, id=${sub.id}`,
    );
  }

  async stopPush() {
    const token = await this.token();
    const subId = await getMsSubscriptionId(this.env.EMAIL_KV, this.account.id);
    if (!subId) return;

    try {
      await http.delete(`${MS_GRAPH_API}/subscriptions/${subId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // 删除失败不影响主流程
    }
    await deleteMsSubscription(this.env.EMAIL_KV, this.account.id);
    console.log(`Outlook subscription stopped for ${this.account.email}`);
  }

  // ─── 邮件正文获取 ──────────────────────────────────────────────────────

  async fetchRawEmail(messageId: string): Promise<ArrayBuffer> {
    return fetchRawMime(await this.token(), messageId);
  }

  // ─── Message actions ──────────────────────────────────────────────────

  async markAsRead(messageId: string) {
    await graphPatch(await this.token(), `/me/messages/${messageId}`, {
      isRead: true,
    });
  }

  async addStar(messageId: string) {
    await graphPatch(await this.token(), `/me/messages/${messageId}`, {
      flag: { flagStatus: "flagged" },
    });
  }

  async removeStar(messageId: string) {
    await graphPatch(await this.token(), `/me/messages/${messageId}`, {
      flag: { flagStatus: "notFlagged" },
    });
  }

  async isStarred(messageId: string) {
    const msg = await graphGet<GraphMessage>(
      await this.token(),
      `/me/messages/${messageId}?$select=flag`,
    );
    return msg.flag?.flagStatus === "flagged";
  }

  async isJunk(messageId: string) {
    const token = await this.token();
    const msg = await graphGet<GraphMessage>(
      token,
      `/me/messages/${messageId}?$select=parentFolderId`,
    );
    if (!msg.parentFolderId) return false;
    const junkFolder = await graphGet<GraphFolder>(
      token,
      `/me/mailFolders('JunkEmail')?$select=id`,
    );
    return msg.parentFolderId === junkFolder.id;
  }

  async listUnread(maxResults: number = 20) {
    const data = await graphGet<GraphMessageList>(
      await this.token(),
      `/me/mailFolders('Inbox')/messages?$filter=isRead eq false&$select=id,subject&$top=${maxResults}`,
    );
    if (!data.value) return [];
    return data.value.map((m) => ({ id: m.id, subject: m.subject }));
  }

  async listStarred(maxResults: number = 20) {
    const data = await graphGet<GraphMessageList>(
      await this.token(),
      `/me/messages?$filter=flag/flagStatus eq 'flagged'&$select=id,subject&$top=${maxResults}`,
    );
    if (!data.value) return [];
    return data.value.map((m) => ({ id: m.id, subject: m.subject }));
  }

  async listJunk(maxResults: number = 20) {
    const data = await graphGet<GraphMessageList>(
      await this.token(),
      `/me/mailFolders('JunkEmail')/messages?$select=id,subject&$top=${maxResults}`,
    );
    if (!data.value) return [];
    return data.value.map((m) => ({ id: m.id, subject: m.subject }));
  }

  async markAsJunk(messageId: string) {
    await graphPost(await this.token(), `/me/messages/${messageId}/move`, {
      destinationId: "JunkEmail",
    });
  }

  async moveToInbox(messageId: string): Promise<string> {
    const token = await this.token();
    try {
      const moved = await http
        .post(`${MS_GRAPH_API_BETA}/me/messages/${messageId}/reportMessage`, {
          headers: { Authorization: `Bearer ${token}` },
          json: { IsMessageMoveRequested: true, ReportAction: "notJunk" },
        })
        .json<GraphMessage>();
      if (moved?.id) return moved.id;
    } catch (err) {
      // beta reportMessage 未就绪时降级到 v1.0 /move（仍会换 id，但不反馈 EOP）
      await reportErrorToObservability(
        this.env,
        "outlook.report_not_junk_failed",
        err,
        { accountId: this.account.id },
      );
    }
    const moved = await graphPost<GraphMessage>(
      token,
      `/me/messages/${messageId}/move`,
      { destinationId: "Inbox" },
    );
    if (!moved?.id) {
      throw new Error("Outlook move response missing new message id");
    }
    return moved.id;
  }

  async trashMessage(messageId: string) {
    await graphPost(await this.token(), `/me/messages/${messageId}/move`, {
      destinationId: "DeletedItems",
    });
  }

  async trashAllJunk() {
    const token = await this.token();
    const data = await graphGet<GraphMessageList>(
      token,
      `/me/mailFolders('JunkEmail')/messages?$select=id&$top=100`,
    );
    if (!data.value || data.value.length === 0) return 0;
    const ids = data.value.map((m) => m.id);
    await Promise.all(
      ids.map((id) =>
        graphPost(token, `/me/messages/${id}/move`, {
          destinationId: "DeletedItems",
        }),
      ),
    );
    return ids.length;
  }
}
