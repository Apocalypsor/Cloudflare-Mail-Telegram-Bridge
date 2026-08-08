import {
  GMAIL_MODIFY_SCOPE,
  GOOGLE_OAUTH_AUTHORIZE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
} from "@worker/constants";
import {
  getAccountsByEmail,
  getHistoryId,
  putHistoryId,
} from "@worker/db/accounts";
import { EmailProvider } from "@worker/providers/base";
import type {
  GmailHistoryResponse,
  GmailMessage,
  GmailMessageList,
  GmailPayload,
  GmailProfile,
  GmailRawMessage,
  GmailWatchResponse,
} from "@worker/providers/gmail/types";
import { gmailGet, gmailPost } from "@worker/providers/gmail/utils/api";
import { gmailGetAttachmentDataStream } from "@worker/providers/gmail/utils/attachment-stream";
import { getAccessToken } from "@worker/providers/gmail/utils/auth";
import {
  countGmailMessagesByQuery,
  listGmailMessagesByLabel,
  listGmailMessagesByLabelPage,
  listGmailMessagesByQuery,
  listGmailMessagesByQueryPage,
} from "@worker/providers/gmail/utils/list";
import {
  collectAttachmentMeta,
  collectInlineAttachmentIds,
  collectInlineParts,
  extractHeader,
  extractPartByMime,
  findAttachmentPayloadById,
  findAttachmentPayloadByIndex,
} from "@worker/providers/gmail/utils/payload";
import type {
  EmailListPage,
  MessageState,
  PreviewContent,
  RawEmailWithState,
} from "@worker/providers/types";
import type {
  Account,
  Env,
  MailAttachmentDownload,
  MailMeta,
  WaitUntil,
} from "@worker/types";
import {
  base64urlToArrayBuffer,
  base64urlToByteStream,
} from "@worker/utils/base64url";
import { parseEmailDate, wrapPlainText } from "@worker/utils/mail/body";
import {
  createEmailDeliveryScheduleContext,
  scheduleEmailDeliveries,
} from "@worker/utils/mail-delivery/dispatch";
import { HTTPError } from "ky";

export class GmailProvider extends EmailProvider {
  static displayName = "Gmail";
  static needsArchiveSetup = true;

  static canArchive(account: Account): boolean {
    return !!account.archive_folder;
  }

  private static messageStateFromLabels(labels: string[]): MessageState {
    if (labels.includes("TRASH")) return { location: "deleted" };
    if (labels.includes("SPAM")) return { location: "junk" };
    if (!labels.includes("INBOX")) return { location: "archive" };
    return { location: "inbox", starred: labels.includes("STARRED") };
  }

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
    return this.memoizeAccessToken(() =>
      getAccessToken(this.env, this.account),
    );
  }

  // ─── Push dispatch ────────────────────────────────────────────────────

  /** 解析 Pub/Sub 通知，获取新邮件列表并安排后台投递 */
  static async dispatch(
    body: { message: { data: string } },
    env: Env,
    waitUntil: WaitUntil,
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

    const scheduleContext = createEmailDeliveryScheduleContext();
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

      const scheduled = scheduleEmailDeliveries(
        env,
        messageIds.map((id) => ({
          accountId: account.id,
          emailMessageId: id,
        })),
        waitUntil,
        scheduleContext,
      );
      console.log(
        `Found ${messageIds.length} new messages for ${account.email} (#${account.id}), scheduled ${scheduled}`,
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

  async fetchRawEmailWithState(messageId: string): Promise<RawEmailWithState> {
    const msg = await gmailGet<GmailRawMessage>(
      await this.token(),
      `/users/me/messages/${messageId}?format=raw`,
    );
    return {
      rawEmail: base64urlToArrayBuffer(msg.raw),
      state: msg.labelIds
        ? GmailProvider.messageStateFromLabels(msg.labelIds)
        : null,
    };
  }

  /** Gmail 走 API 直接取结构化 payload，比 fetchRawEmail + PostalMime 高效 */
  async fetchForPreview(messageId: string): Promise<PreviewContent | null> {
    const token = await this.token();
    const msg = await gmailGet<{ payload: GmailPayload }>(
      token,
      `/users/me/messages/${messageId}?format=full`,
    );
    const meta: MailMeta = {
      subject: extractHeader(msg.payload, "subject"),
      from: extractHeader(msg.payload, "from"),
      to: extractHeader(msg.payload, "to"),
      date: parseEmailDate(extractHeader(msg.payload, "date")),
    };
    const html = extractPartByMime(msg.payload, "text/html");

    const cidMap = new Map<string, string>();
    collectInlineParts(msg.payload, cidMap);
    const attachments = collectAttachmentMeta(msg.payload);

    // 需要通过附件 API 获取的内联图片
    const pending: { cid: string; mimeType: string; attachmentId: string }[] =
      [];
    collectInlineAttachmentIds(msg.payload, pending);
    if (pending.length > 0) {
      await Promise.all(
        pending.map(async ({ cid, mimeType, attachmentId }) => {
          const att = await gmailGet<{ data?: string }>(
            token,
            `/users/me/messages/${encodeURIComponent(
              messageId,
            )}/attachments/${encodeURIComponent(attachmentId)}`,
          );
          if (att.data) {
            // Gmail 返回的是 base64url，转为标准 base64
            const b64 = att.data.replace(/-/g, "+").replace(/_/g, "/");
            cidMap.set(cid, `data:${mimeType};base64,${b64}`);
          }
        }),
      );
    }

    if (html) return { html, cidMap, meta, attachments };

    const plain = extractPartByMime(msg.payload, "text/plain");
    if (plain) return { html: wrapPlainText(plain), cidMap, meta, attachments };

    return null;
  }

  async fetchAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<MailAttachmentDownload | null> {
    const token = await this.token();
    const msg = await gmailGet<{ payload: GmailPayload }>(
      token,
      `/users/me/messages/${messageId}?format=full`,
    );
    const part =
      findAttachmentPayloadById(msg.payload, attachmentId) ??
      findAttachmentPayloadByIndex(msg.payload, attachmentId);
    if (!part) return null;

    let body: MailAttachmentDownload["body"] | null = null;
    if (part.body?.attachmentId) {
      body = await gmailGetAttachmentDataStream(
        token,
        messageId,
        part.body.attachmentId,
      );
    } else if (part.body?.data) {
      body = base64urlToByteStream(part.body.data);
    }
    if (!body) return null;

    return {
      filename: part.filename || null,
      mimeType: part.mimeType ?? null,
      body,
    };
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

  /**
   * Gmail 的 labelIds 已经包含了所有状态信息，一次 API 调用搞定。
   * 注：Gmail 「归档」= 不在 INBOX 也不在 SPAM/TRASH；用户配置的 archive_folder
   * 只是可选的附加 label，即使没配，只要消息离开 INBOX 我们也视为归档。
   */
  async resolveMessageState(messageId: string): Promise<MessageState> {
    try {
      const msg = await gmailGet<GmailMessage>(
        await this.token(),
        `/users/me/messages/${messageId}?format=MINIMAL`,
      );
      return GmailProvider.messageStateFromLabels(msg.labelIds ?? []);
    } catch (err) {
      if (err instanceof HTTPError && err.response.status === 404) {
        return { location: "deleted" };
      }
      throw err;
    }
  }

  async listUnread(maxResults: number = 20) {
    const token = await this.token();
    return listGmailMessagesByQuery(token, "is:unread", maxResults);
  }

  async countUnread(maxCount?: number) {
    const token = await this.token();
    return countGmailMessagesByQuery(
      token,
      "is:unread",
      this.normalizeCountLimit(maxCount),
    );
  }

  async listUnreadPage(
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return listGmailMessagesByQueryPage(
      await this.token(),
      "is:unread",
      maxResults,
      cursor,
    );
  }

  async listStarred(maxResults: number = 20) {
    const token = await this.token();
    return listGmailMessagesByQuery(token, "is:starred", maxResults);
  }

  async listStarredPage(
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return listGmailMessagesByQueryPage(
      await this.token(),
      "is:starred",
      maxResults,
      cursor,
    );
  }

  async listJunk(maxResults: number = 20) {
    const token = await this.token();
    return listGmailMessagesByQuery(token, "in:spam", maxResults);
  }

  async countJunk(maxCount?: number) {
    const token = await this.token();
    return countGmailMessagesByQuery(
      token,
      "in:spam",
      this.normalizeCountLimit(maxCount),
    );
  }

  async listJunkPage(
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return listGmailMessagesByQueryPage(
      await this.token(),
      "in:spam",
      maxResults,
      cursor,
    );
  }

  async searchMessages(query: string, maxResults: number = 20) {
    // Gmail `q=` 直接吃用户原文（from:/subject:/has: 等高级语法都支持）。
    return listGmailMessagesByQuery(await this.token(), query, maxResults);
  }

  async searchMessagesPage(
    query: string,
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    // Gmail `q=` 直接吃用户原文（from:/subject:/has: 等高级语法都支持）。
    return listGmailMessagesByQueryPage(
      await this.token(),
      query,
      maxResults,
      cursor,
    );
  }

  async listArchived(maxResults: number = 20) {
    const labelId = this.account.archive_folder;
    if (!labelId) return [];
    const token = await this.token();
    return listGmailMessagesByLabel(token, labelId, maxResults);
  }

  async listArchivedPage(
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    const labelId = this.account.archive_folder;
    if (!labelId) return { items: [], nextCursor: null };
    return listGmailMessagesByLabelPage(
      await this.token(),
      labelId,
      maxResults,
      cursor,
    );
  }

  async markAllAsRead(maxResults: number = 20) {
    // list unread → batchModify removeLabelIds=["UNREAD"]，1 个 modify call 全搞定。
    // batchModify 要么整批成功要么整批抛 —— 没有部分失败概念，所以 failed 始终 0。
    const token = await this.token();
    const data = await gmailGet<GmailMessageList>(
      token,
      `/users/me/messages?q=is:unread&maxResults=${maxResults}`,
    );
    if (!data.messages || data.messages.length === 0)
      return { success: 0, failed: 0 };
    const ids = data.messages.map((m) => m.id);
    await gmailPost(token, "/users/me/messages/batchModify", {
      ids,
      removeLabelIds: ["UNREAD"],
    });
    return { success: ids.length, failed: 0 };
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

  async unarchiveMessage(messageId: string): Promise<string> {
    const labelId = this.account.archive_folder;
    await gmailPost(
      await this.token(),
      `/users/me/messages/${messageId}/modify`,
      {
        addLabelIds: ["INBOX"],
        removeLabelIds: labelId ? [labelId] : [],
      },
    );
    return messageId;
  }

  async archiveMessage(messageId: string) {
    const labelId = this.account.archive_folder;
    if (!labelId) {
      throw new Error("Gmail archive requires archive_folder (label ID)");
    }
    await gmailPost(
      await this.token(),
      `/users/me/messages/${messageId}/modify`,
      {
        addLabelIds: [labelId],
        removeLabelIds: ["INBOX"],
      },
    );
  }

  /** 列出账号下所有用户标签（过滤系统标签），用于归档标签选择 UI */
  async listLabels(): Promise<{ id: string; name: string }[]> {
    const data = await gmailGet<{
      labels?: { id: string; name: string; type?: string }[];
    }>(await this.token(), "/users/me/labels");
    if (!data.labels) return [];
    return data.labels
      .filter((l) => l.type === "user")
      .map(({ id, name }) => ({ id, name }));
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
}
