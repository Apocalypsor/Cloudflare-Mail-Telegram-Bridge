import { getAccountById, getImapAccounts } from "@db/accounts";
import { requireBearer } from "@handlers/hono/middleware";
import { EmailProvider } from "@providers/base";
import { callBridge, syncAccounts } from "@providers/imap/utils";
import type { EmailListItem, MessageState } from "@providers/types";
import { base64ToArrayBuffer } from "@utils/base64url";
import type { Hono } from "hono";
import { IMAP_FLAG_FLAGGED, IMAP_FLAG_SEEN } from "@/constants";
import type { AppEnv, Env } from "@/types";

export {
  checkImapBridgeHealth,
  syncAccounts,
} from "@providers/imap/utils";

/**
 * IMAP provider —— 所有 `messageId` 参数都是 RFC 822 Message-Id（全局唯一，跨 folder
 * 稳定）。不是 IMAP UID。middleware 会按 `SEARCH HEADER Message-Id` 在相关 folder
 * 里找到当前 UID 再操作。
 */
export class ImapProvider extends EmailProvider {
  static displayName = "IMAP";
  /** IMAP bridge 拉账号列表的 HTTP 路径 */
  private static readonly ROUTE_ACCOUNTS = "/api/imap/accounts";
  /** IMAP bridge 推送新邮件通知的 HTTP 路径 */
  private static readonly ROUTE_PUSH = "/api/imap/push";

  /** 账号状态变化后立即通知 bridge reconcile（不等下次 sync） */
  async onPersistedChange() {
    if (!this.env.IMAP_BRIDGE_URL || !this.env.IMAP_BRIDGE_SECRET) return;
    await syncAccounts(this.env);
  }

  // ─── HTTP routes ──────────────────────────────────────────────────────

  /**
   * 注册 IMAP bridge 用到的路由：
   *  - `GET  /api/imap/accounts` — bridge 定期拉取 IMAP 账号列表
   *  - `POST /api/imap/push`     — bridge 检测到新邮件时通知 worker
   */
  static registerRoutes(app: Hono<AppEnv>): void {
    const auth = requireBearer("IMAP_BRIDGE_SECRET");
    app.get(ImapProvider.ROUTE_ACCOUNTS, auth, async (c) => {
      const accounts = await getImapAccounts(c.env.DB);
      return c.json(
        accounts.map((acc) => ({
          id: acc.id,
          email: acc.email,
          chat_id: acc.chat_id,
          imap_host: acc.imap_host,
          imap_port: acc.imap_port,
          imap_secure: !!acc.imap_secure,
          imap_user: acc.imap_user,
          imap_pass: acc.imap_pass,
        })),
      );
    });
    app.post(ImapProvider.ROUTE_PUSH, auth, async (c) => {
      const body = await c.req.json();
      await ImapProvider.enqueue(body, c.env);
      return c.text("OK");
    });
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
    await env.EMAIL_QUEUE.send({ accountId, emailMessageId: rfcMessageId });
  }

  // ─── Message actions ──────────────────────────────────────────────────

  async markAsRead(messageId: string) {
    await callBridge(this.env, "POST", "/api/flag", {
      accountId: this.account.id,
      rfcMessageId: messageId,
      flag: IMAP_FLAG_SEEN,
      add: true,
    });
  }

  async addStar(messageId: string) {
    await callBridge(this.env, "POST", "/api/flag", {
      accountId: this.account.id,
      rfcMessageId: messageId,
      flag: IMAP_FLAG_FLAGGED,
      add: true,
    });
  }

  async removeStar(messageId: string) {
    await callBridge(this.env, "POST", "/api/flag", {
      accountId: this.account.id,
      rfcMessageId: messageId,
      flag: IMAP_FLAG_FLAGGED,
      add: false,
    });
  }

  async isStarred(messageId: string) {
    const resp = await callBridge(this.env, "POST", "/api/is-starred", {
      accountId: this.account.id,
      rfcMessageId: messageId,
    });
    const { starred } = (await resp.json()) as { starred: boolean };
    return starred;
  }

  async isJunk(messageId: string) {
    const resp = await callBridge(this.env, "POST", "/api/is-junk", {
      accountId: this.account.id,
      rfcMessageId: messageId,
    });
    const { junk } = (await resp.json()) as { junk: boolean };
    return junk;
  }

  /**
   * 按 RFC Message-Id 跨 folder 定位邮件。bridge `/api/locate` 并行查 INBOX / junk /
   * archive / trash，返回精确位置 + （inbox 时的）星标状态。
   *
   * 不吞 error —— bridge 瞬时不可达就直接抛给 `reconcileMessageState`，不会误删 TG。
   */
  async resolveMessageState(messageId: string): Promise<MessageState> {
    const resp = await callBridge(this.env, "POST", "/api/locate", {
      accountId: this.account.id,
      rfcMessageId: messageId,
      // 用户自定义的归档文件夹路径；bridge 没配就自动探测 \Archive special-use
      archiveFolder: this.account.archive_folder ?? undefined,
    });
    const body = (await resp.json()) as {
      location: "inbox" | "junk" | "archive" | "deleted";
      starred?: boolean;
    };
    if (body.location === "inbox") {
      return { location: "inbox", starred: body.starred ?? false };
    }
    return { location: body.location };
  }

  async listUnread(maxResults: number = 20) {
    const resp = await callBridge(this.env, "POST", "/api/unread", {
      accountId: this.account.id,
      maxResults,
    });
    const { messages } = (await resp.json()) as {
      messages: { id: string; subject?: string }[];
    };
    return messages ?? [];
  }

  async listStarred(maxResults: number = 20) {
    const resp = await callBridge(this.env, "POST", "/api/starred", {
      accountId: this.account.id,
      maxResults,
    });
    const { messages } = (await resp.json()) as {
      messages: { id: string; subject?: string }[];
    };
    return messages ?? [];
  }

  async listJunk(maxResults: number = 20) {
    const resp = await callBridge(this.env, "POST", "/api/junk", {
      accountId: this.account.id,
      maxResults,
    });
    const { messages } = (await resp.json()) as {
      messages: { id: string; subject?: string }[];
    };
    return messages ?? [];
  }

  async listArchived(maxResults: number = 20): Promise<EmailListItem[]> {
    const resp = await callBridge(this.env, "POST", "/api/list-folder", {
      accountId: this.account.id,
      folder: this.account.archive_folder ?? undefined,
      maxResults,
    });
    const { messages } = (await resp.json()) as {
      messages: { id: string; subject?: string }[];
    };
    return messages ?? [];
  }

  async searchMessages(
    query: string,
    maxResults: number = 20,
  ): Promise<EmailListItem[]> {
    const resp = await callBridge(this.env, "POST", "/api/search", {
      accountId: this.account.id,
      query,
      maxResults,
    });
    const { messages } = (await resp.json()) as {
      messages: { id: string; subject?: string; from?: string }[];
    };
    return messages ?? [];
  }

  async markAsJunk(messageId: string) {
    await callBridge(this.env, "POST", "/api/mark-as-junk", {
      accountId: this.account.id,
      rfcMessageId: messageId,
    });
  }

  /**
   * Junk → INBOX。Message-Id 不会因为 folder 移动而变，所以返回同一个 id。
   * 保持 abstract signature（Outlook/Gmail 会换 id）的 `Promise<string>`。
   */
  async moveToInbox(messageId: string): Promise<string> {
    await callBridge(this.env, "POST", "/api/move-to-inbox", {
      accountId: this.account.id,
      rfcMessageId: messageId,
    });
    return messageId;
  }

  async unarchiveMessage(messageId: string): Promise<string> {
    await callBridge(this.env, "POST", "/api/unarchive", {
      accountId: this.account.id,
      rfcMessageId: messageId,
      archiveFolder: this.account.archive_folder ?? undefined,
    });
    return messageId;
  }

  async trashMessage(messageId: string) {
    await callBridge(this.env, "POST", "/api/trash", {
      accountId: this.account.id,
      rfcMessageId: messageId,
    });
  }

  async archiveMessage(messageId: string) {
    await callBridge(this.env, "POST", "/api/archive", {
      accountId: this.account.id,
      rfcMessageId: messageId,
      // 只在用户明确配置过时传；否则让 bridge 自动探测 \Archive special-use
      folder: this.account.archive_folder ?? undefined,
    });
  }

  async trashAllJunk() {
    const resp = await callBridge(this.env, "POST", "/api/trash-all-junk", {
      accountId: this.account.id,
    });
    const { count } = (await resp.json()) as { count: number };
    return count;
  }

  /** 通过 IMAP bridge 拉取单封邮件原文，返回 ArrayBuffer */
  async fetchRawEmail(
    messageId: string,
    folder?: "inbox" | "junk" | "archive",
  ): Promise<ArrayBuffer> {
    const resp = await callBridge(this.env, "POST", "/api/fetch", {
      accountId: this.account.id,
      rfcMessageId: messageId,
      folder,
      // archive folder 路径只在 hint 为 archive 时有意义
      archiveFolder:
        folder === "archive"
          ? (this.account.archive_folder ?? undefined)
          : undefined,
    });
    const { rawEmail } = (await resp.json()) as { rawEmail: string };
    return base64ToArrayBuffer(rawEmail);
  }
}
