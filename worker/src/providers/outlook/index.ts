import { http } from "@worker/clients/http";
import {
  MS_GRAPH_API,
  MS_GRAPH_API_BETA,
  MS_MAIL_SCOPE,
  MS_OAUTH_AUTHORIZE_URL,
  MS_OAUTH_TOKEN_URL,
  MS_SUBSCRIPTION_LIFETIME_MINUTES,
} from "@worker/constants";
import { getAccountById } from "@worker/db/accounts";
import {
  deleteMsSubscription,
  getCachedOutlookFolderIds,
  getMsAccountBySubscription,
  getMsSubscriptionId,
  type OutlookFolderIds,
  putCachedOutlookFolderIds,
  putMsSubscription,
  refreshMsSubAccountMapping,
} from "@worker/db/kv";
import { EmailProvider } from "@worker/providers/base";
import type {
  GraphMessage,
  GraphMessageList,
} from "@worker/providers/outlook/types";
import {
  fetchRawMime,
  getAccessToken,
  graphBatch,
  graphGet,
  graphPatch,
  graphPost,
} from "@worker/providers/outlook/utils";
import type { MessageState } from "@worker/providers/types";
import {
  type EmailQueueMessage,
  type Env,
  QueueMessageType,
} from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";
import { HTTPError } from "ky";

export class OutlookProvider extends EmailProvider {
  static displayName = "Outlook";
  /** Microsoft Graph webhook 推送变更通知的 HTTP 路径 */
  private static readonly ROUTE_PUSH = "/api/outlook/push";

  static oauth = EmailProvider.createOAuthHandler({
    name: "Microsoft",
    authorizeUrl: MS_OAUTH_AUTHORIZE_URL,
    tokenUrl: MS_OAUTH_TOKEN_URL,
    scope: MS_MAIL_SCOPE,
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
    const batch: Array<{ body: EmailQueueMessage }> = [];

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

      batch.push({
        body: {
          type: QueueMessageType.Email,
          accountId: account.id,
          emailMessageId: messageId,
        },
      });
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
    const notificationUrl = `${workerUrl}${OutlookProvider.ROUTE_PUSH}?secret=${this.env.MS_WEBHOOK_SECRET}`;

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

  /**
   * 拿 4 个 well-known folder ID（Inbox / JunkEmail / archive / DeletedItems）。
   * 首次走 Graph `$batch` 一次 HTTP 拿全 4 个，写 KV 缓存 30 天；之后命中缓存
   * 0 个 HTTP。folder ID 在账号生命周期内稳定，所以长 TTL 安全。
   */
  private async getFolderIds(): Promise<OutlookFolderIds> {
    const cached = await getCachedOutlookFolderIds(
      this.env.EMAIL_KV,
      this.account.id,
    );
    if (cached) return cached;

    const token = await this.token();
    const responses = await graphBatch(token, [
      {
        id: "inbox",
        method: "GET",
        url: `/me/mailFolders('Inbox')?$select=id`,
      },
      {
        id: "junk",
        method: "GET",
        url: `/me/mailFolders('JunkEmail')?$select=id`,
      },
      {
        id: "archive",
        method: "GET",
        url: `/me/mailFolders('archive')?$select=id`,
      },
      {
        id: "deleted",
        method: "GET",
        url: `/me/mailFolders('DeletedItems')?$select=id`,
      },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));
    const get = (key: string): string => {
      const r = byId.get(key);
      if (!r || r.status < 200 || r.status >= 300 || !r.body) {
        throw new Error(
          `Outlook getFolderIds: ${key} sub-request failed (status=${r?.status})`,
        );
      }
      const body = r.body as { id?: string };
      if (!body.id) throw new Error(`Outlook getFolderIds: ${key} missing id`);
      return body.id;
    };
    const ids: OutlookFolderIds = {
      inbox: get("inbox"),
      junk: get("junk"),
      archive: get("archive"),
      deleted: get("deleted"),
    };
    await putCachedOutlookFolderIds(
      this.env.EMAIL_KV,
      this.account.id,
      ids,
    ).catch(() => {
      // 缓存写失败不影响主流程，下次再写
    });
    return ids;
  }

  async isJunk(messageId: string) {
    const token = await this.token();
    const [msg, folders] = await Promise.all([
      graphGet<GraphMessage>(
        token,
        `/me/messages/${messageId}?$select=parentFolderId`,
      ),
      this.getFolderIds(),
    ]);
    return !!msg.parentFolderId && msg.parentFolderId === folders.junk;
  }

  /**
   * 对账邮件位置：拿 parentFolderId + flag，跟 4 个 well-known folder ID 对比。
   * folder ID 走 KV 缓存（`getFolderIds`），warm path 只 1 个 HTTP（取 message
   * 本身），cold path 也只 2 个并发 HTTP（message + 1 个 $batch 拿 4 folder）。
   */
  async resolveMessageState(messageId: string): Promise<MessageState> {
    const token = await this.token();
    try {
      const [msg, folders] = await Promise.all([
        graphGet<GraphMessage>(
          token,
          `/me/messages/${messageId}?$select=flag,parentFolderId`,
        ),
        this.getFolderIds(),
      ]);
      const parent = msg.parentFolderId;
      if (parent === folders.deleted) return { location: "deleted" };
      if (parent === folders.junk) return { location: "junk" };
      if (parent === folders.archive) return { location: "archive" };
      if (parent === folders.inbox) {
        return {
          location: "inbox",
          starred: msg.flag?.flagStatus === "flagged",
        };
      }
      // 其他用户自定义文件夹 —— 统一视作归档（从 INBOX 里移出去了）
      return { location: "archive" };
    } catch (err) {
      if (err instanceof HTTPError && err.response.status === 404) {
        return { location: "deleted" };
      }
      throw err;
    }
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

  async listArchived(maxResults: number = 20) {
    const data = await graphGet<GraphMessageList>(
      await this.token(),
      `/me/mailFolders('archive')/messages?$select=id,subject&$top=${maxResults}`,
    );
    if (!data.value) return [];
    return data.value.map((m) => ({ id: m.id, subject: m.subject }));
  }

  async searchMessages(query: string, maxResults: number = 20) {
    // Graph `$search` 用 KQL：双引号包住整个 query 走全文检索（subject + body + from + ...）。
    // 注：$search 不能与 $filter / $orderby 同用 —— 所以这里没法限定文件夹，是全 mailbox 范围。
    const escaped = query.replace(/"/g, '\\"');
    const data = await graphGet<GraphMessageList>(
      await this.token(),
      `/me/messages?$search=${encodeURIComponent(`"${escaped}"`)}&$select=id,subject,from&$top=${maxResults}`,
    );
    if (!data.value) return [];
    return data.value.map((m) => {
      const ea = m.from?.emailAddress;
      const from = ea?.address
        ? ea.name
          ? `${ea.name} <${ea.address}>`
          : ea.address
        : ea?.name;
      return { id: m.id, subject: m.subject, from };
    });
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

  async archiveMessage(messageId: string) {
    await graphPost(await this.token(), `/me/messages/${messageId}/move`, {
      destinationId: "archive",
    });
  }

  async unarchiveMessage(messageId: string): Promise<string> {
    const moved = await graphPost<GraphMessage>(
      await this.token(),
      `/me/messages/${messageId}/move`,
      { destinationId: "Inbox" },
    );
    if (!moved?.id)
      throw new Error("Outlook unarchive response missing new message id");
    return moved.id;
  }

  async trashAllJunk() {
    const token = await this.token();
    const data = await graphGet<GraphMessageList>(
      token,
      `/me/mailFolders('JunkEmail')/messages?$select=id&$top=100`,
    );
    if (!data.value || data.value.length === 0) return 0;
    const ids = data.value.map((m) => m.id);
    // Graph $batch：100 封 → 5 个 HTTP 请求（每批 20）。整批的子请求失败不影响其他子请求。
    const responses = await graphBatch(
      token,
      ids.map((id, i) => ({
        id: String(i),
        method: "POST",
        url: `/me/messages/${id}/move`,
        body: { destinationId: "DeletedItems" },
      })),
    );
    return responses.filter((r) => r.status >= 200 && r.status < 300).length;
  }

  async markAllAsRead(maxResults: number = 20) {
    const token = await this.token();
    const data = await graphGet<GraphMessageList>(
      token,
      `/me/mailFolders('Inbox')/messages?$filter=isRead eq false&$select=id&$top=${maxResults}`,
    );
    if (!data.value || data.value.length === 0)
      return { success: 0, failed: 0 };
    const ids = data.value.map((m) => m.id);
    const responses = await graphBatch(
      token,
      ids.map((id, i) => ({
        id: String(i),
        method: "PATCH",
        url: `/me/messages/${id}`,
        body: { isRead: true },
      })),
    );
    let success = 0;
    let failed = 0;
    for (const r of responses) {
      if (r.status >= 200 && r.status < 300) success++;
      else failed++;
    }
    return { success, failed };
  }
}
