import { IMAP_FLAG_FLAGGED, IMAP_FLAG_SEEN } from "@worker/constants";
import { getAccountById } from "@worker/db/accounts";
import { EmailProvider } from "@worker/providers/base";
import {
  bridgeCall,
  bridgeClient,
  syncAccounts,
} from "@worker/providers/imap/utils";
import type { EmailListItem, MessageState } from "@worker/providers/types";
import { type Env, QueueMessageType } from "@worker/types";
import { base64ToArrayBuffer } from "@worker/utils/base64url";

export {
  checkImapBridgeHealth,
  syncAccounts,
} from "@worker/providers/imap/utils";

/**
 * IMAP provider —— 所有 `messageId` 参数都是 RFC 822 Message-Id（全局唯一，跨 folder
 * 稳定）。不是 IMAP UID。middleware 会按 `SEARCH HEADER Message-Id` 在相关 folder
 * 里找到当前 UID 再操作。
 *
 * Bridge 通信走 Eden treaty —— 所有 path / body / response 都从
 * `@middleware/index` 自动推导，middleware 那边改 schema 这里立刻报错。
 * Treaty 配 `throwHttpError: true`，非 2xx 直接抛 `EdenFetchError`，
 * 调用方拿到的是 success branch（`data` 是响应类型）。
 */
export class ImapProvider extends EmailProvider {
  static displayName = "IMAP";

  /** 账号状态变化后立即通知 bridge reconcile（不等下次 sync） */
  async onPersistedChange() {
    if (!this.env.IMAP_BRIDGE_URL || !this.env.IMAP_BRIDGE_SECRET) return;
    await syncAccounts(this.env);
  }

  // ─── Enqueue ──────────────────────────────────────────────────────────

  /** 解析 IMAP bridge 推送通知并入队。payload 里 `rfcMessageId` 是 RFC 822 Message-Id。 */
  static async enqueue(
    body: { accountId: number; rfcMessageId: string },
    env: Env,
  ): Promise<void> {
    const { accountId, rfcMessageId } = body;

    if (typeof accountId !== "number" || accountId <= 0 || !rfcMessageId) {
      throw new Error("Missing required fields: accountId, rfcMessageId");
    }

    const account = await getAccountById(env.DB, accountId);
    if (!account) {
      console.log(`IMAP push: account ${accountId} not found, skipping`);
      return;
    }

    console.log(
      `IMAP push: new message for ${account.email}, rfcMessageId=${rfcMessageId}`,
    );
    // 队列里用 emailMessageId 字段（跨 provider 统一）；对 IMAP 来说它就是 RFC Message-Id
    await env.EMAIL_QUEUE.send({
      type: QueueMessageType.Email,
      accountId,
      emailMessageId: rfcMessageId,
    });
  }

  // ─── Message actions ──────────────────────────────────────────────────

  private get bridge() {
    return bridgeClient(this.env);
  }

  async markAsRead(messageId: string) {
    await this.bridge.api.flag.post({
      accountId: this.account.id,
      rfcMessageId: messageId,
      flag: IMAP_FLAG_SEEN,
      add: true,
    });
  }

  async addStar(messageId: string) {
    await this.bridge.api.flag.post({
      accountId: this.account.id,
      rfcMessageId: messageId,
      flag: IMAP_FLAG_FLAGGED,
      add: true,
    });
  }

  async removeStar(messageId: string) {
    await this.bridge.api.flag.post({
      accountId: this.account.id,
      rfcMessageId: messageId,
      flag: IMAP_FLAG_FLAGGED,
      add: false,
    });
  }

  async isStarred(messageId: string) {
    const data = await bridgeCall(
      this.bridge.api["is-starred"].post({
        accountId: this.account.id,
        rfcMessageId: messageId,
      }),
    );
    return data.starred;
  }

  async isJunk(messageId: string) {
    const data = await bridgeCall(
      this.bridge.api["is-junk"].post({
        accountId: this.account.id,
        rfcMessageId: messageId,
      }),
    );
    return data.junk;
  }

  /**
   * 按 RFC Message-Id 跨 folder 定位邮件。bridge `/api/locate` 并行查 INBOX / junk /
   * archive / trash，返回精确位置 + （inbox 时的）星标状态。
   *
   * 不吞 error —— bridge 瞬时不可达就直接抛给 `reconcileMessageState`，不会误删 TG。
   */
  async resolveMessageState(messageId: string): Promise<MessageState> {
    const data = await bridgeCall(
      this.bridge.api.locate.post({
        accountId: this.account.id,
        rfcMessageId: messageId,
        // 用户自定义的归档文件夹路径；bridge 没配就自动探测 \Archive special-use
        archiveFolder: this.account.archive_folder ?? undefined,
      }),
    );
    if (data.location === "inbox") {
      return { location: "inbox", starred: data.starred ?? false };
    }
    return { location: data.location };
  }

  async listUnread(maxResults: number = 20) {
    const data = await bridgeCall(
      this.bridge.api.unread.post({
        accountId: this.account.id,
        maxResults,
      }),
    );
    return data.messages ?? [];
  }

  async listStarred(maxResults: number = 20) {
    const data = await bridgeCall(
      this.bridge.api.starred.post({
        accountId: this.account.id,
        maxResults,
      }),
    );
    return data.messages ?? [];
  }

  async listJunk(maxResults: number = 20) {
    const data = await bridgeCall(
      this.bridge.api.junk.post({
        accountId: this.account.id,
        maxResults,
      }),
    );
    return data.messages ?? [];
  }

  async listArchived(maxResults: number = 20): Promise<EmailListItem[]> {
    const data = await bridgeCall(
      this.bridge.api["list-folder"].post({
        accountId: this.account.id,
        folder: this.account.archive_folder ?? undefined,
        maxResults,
      }),
    );
    return data.messages ?? [];
  }

  async searchMessages(
    query: string,
    maxResults: number = 20,
  ): Promise<EmailListItem[]> {
    const data = await bridgeCall(
      this.bridge.api.search.post({
        accountId: this.account.id,
        query,
        maxResults,
      }),
    );
    return data.messages ?? [];
  }

  async markAllAsRead(_maxResults?: number) {
    // IMAP 一条 STORE +\Seen 就把整 INBOX 未读全标了，maxResults 在这里被忽略 ——
    // bridge 会 SEARCH UNSEEN 拿全部未读 UID 一起 STORE，没有 partial-failure 概念。
    const data = await bridgeCall(
      this.bridge.api["mark-all-read"].post({
        accountId: this.account.id,
      }),
    );
    return { success: data.count, failed: 0 };
  }

  async markAsJunk(messageId: string) {
    await this.bridge.api["mark-as-junk"].post({
      accountId: this.account.id,
      rfcMessageId: messageId,
    });
  }

  /**
   * Junk → INBOX。Message-Id 不会因为 folder 移动而变，所以返回同一个 id。
   * 保持 abstract signature（Outlook/Gmail 会换 id）的 `Promise<string>`。
   */
  async moveToInbox(messageId: string): Promise<string> {
    await this.bridge.api["move-to-inbox"].post({
      accountId: this.account.id,
      rfcMessageId: messageId,
    });
    return messageId;
  }

  async unarchiveMessage(messageId: string): Promise<string> {
    await this.bridge.api.unarchive.post({
      accountId: this.account.id,
      rfcMessageId: messageId,
      archiveFolder: this.account.archive_folder ?? undefined,
    });
    return messageId;
  }

  async trashMessage(messageId: string) {
    await this.bridge.api.trash.post({
      accountId: this.account.id,
      rfcMessageId: messageId,
    });
  }

  async archiveMessage(messageId: string) {
    await this.bridge.api.archive.post({
      accountId: this.account.id,
      rfcMessageId: messageId,
      // 只在用户明确配置过时传；否则让 bridge 自动探测 \Archive special-use
      folder: this.account.archive_folder ?? undefined,
    });
  }

  async trashAllJunk() {
    const data = await bridgeCall(
      this.bridge.api["trash-all-junk"].post({
        accountId: this.account.id,
      }),
    );
    return data.count;
  }

  /** 通过 IMAP bridge 拉取单封邮件原文，返回 ArrayBuffer */
  async fetchRawEmail(
    messageId: string,
    folder?: "inbox" | "junk" | "archive",
  ): Promise<ArrayBuffer> {
    const data = await bridgeCall(
      this.bridge.api.fetch.post({
        accountId: this.account.id,
        rfcMessageId: messageId,
        folder,
        // archive folder 路径只在 hint 为 archive 时有意义
        archiveFolder:
          folder === "archive"
            ? (this.account.archive_folder ?? undefined)
            : undefined,
      }),
    );
    return base64ToArrayBuffer(data.rawEmail);
  }
}
