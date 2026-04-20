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

  /** 解析 IMAP bridge 推送通知并入队 */
  static async enqueue(
    body: { accountId: number; messageId: string },
    env: Env,
  ): Promise<void> {
    const { accountId, messageId } = body;

    if (typeof accountId !== "number" || accountId <= 0 || !messageId) {
      throw new Error("Missing required fields: accountId, messageId");
    }

    const account = await getAccountById(env.DB, accountId);
    if (!account) {
      console.log(`IMAP push: account ${accountId} not found, skipping`);
      return;
    }

    console.log(
      `IMAP push: new message for ${account.email}, messageId=${messageId}`,
    );
    await env.EMAIL_QUEUE.send({ accountId, messageId });
  }

  // ─── Message actions ──────────────────────────────────────────────────

  async markAsRead(messageId: string) {
    await callBridge(this.env, "POST", "/api/flag", {
      accountId: this.account.id,
      messageId,
      flag: IMAP_FLAG_SEEN,
      add: true,
    });
  }

  async addStar(messageId: string) {
    await callBridge(this.env, "POST", "/api/flag", {
      accountId: this.account.id,
      messageId,
      flag: IMAP_FLAG_FLAGGED,
      add: true,
    });
  }

  async removeStar(messageId: string) {
    await callBridge(this.env, "POST", "/api/flag", {
      accountId: this.account.id,
      messageId,
      flag: IMAP_FLAG_FLAGGED,
      add: false,
    });
  }

  async isStarred(messageId: string) {
    const resp = await callBridge(this.env, "POST", "/api/is-starred", {
      accountId: this.account.id,
      messageId,
    });
    const { starred } = (await resp.json()) as { starred: boolean };
    return starred;
  }

  async isJunk(messageId: string) {
    const resp = await callBridge(this.env, "POST", "/api/is-junk", {
      accountId: this.account.id,
      messageId,
    });
    const { junk } = (await resp.json()) as { junk: boolean };
    return junk;
  }

  /**
   * IMAP UID 是 per-folder 的，bridge 又只按 INBOX UID 寻址 —— 这里只能 best-effort：
   * 先看 `/api/is-junk`，再看 `/api/is-starred`，都通过就当作 inbox。
   *
   * **不吞 error**（和 Gmail/Outlook 的契约保持一致）：bridge 瞬时不可达 / 鉴权失败
   * 等错误直接向上抛，由 `reconcileMessageState` 捕获后不动 TG 消息。如果吞成
   * `deleted`，reconcile 会误删 TG + mapping，bridge 一次抖动就丢用户数据。
   *
   * 遗留限制：用户在外部邮件客户端把邮件移进 archive（UID 在 INBOX 已失效）时，
   * 此方法可能返回 `{ inbox, starred: false }`（bridge 的 isJunk/isStarred 搜不到
   * 就返回 false，而不是抛错）。TG 消息会留着直到下次正确对账 —— 不丢数据，只是
   * 残留。彻底解决需要用 RFC Message-Id 做跨 folder 检索（Step B）。
   */
  async resolveMessageState(messageId: string): Promise<MessageState> {
    if (await this.isJunk(messageId)) return { location: "junk" };
    const starred = await this.isStarred(messageId);
    return { location: "inbox", starred };
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

  async markAsJunk(messageId: string) {
    await callBridge(this.env, "POST", "/api/mark-as-junk", {
      accountId: this.account.id,
      messageId,
    });
  }

  async moveToInbox(messageId: string): Promise<string> {
    const resp = await callBridge(this.env, "POST", "/api/move-to-inbox", {
      accountId: this.account.id,
      messageId,
    });
    const { newMessageId } = (await resp.json()) as { newMessageId?: string };
    if (!newMessageId) {
      throw new Error(
        "IMAP bridge /api/move-to-inbox did not return newMessageId",
      );
    }
    return newMessageId;
  }

  async unarchiveMessage(messageId: string): Promise<string> {
    const resp = await callBridge(this.env, "POST", "/api/unarchive", {
      accountId: this.account.id,
      messageId,
      archiveFolder: this.account.archive_folder ?? undefined,
    });
    const { newMessageId } = (await resp.json()) as { newMessageId?: string };
    if (!newMessageId) {
      throw new Error("IMAP bridge /api/unarchive did not return newMessageId");
    }
    return newMessageId;
  }

  async trashMessage(messageId: string) {
    await callBridge(this.env, "POST", "/api/trash", {
      accountId: this.account.id,
      messageId,
    });
  }

  async archiveMessage(messageId: string) {
    await callBridge(this.env, "POST", "/api/archive", {
      accountId: this.account.id,
      messageId,
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
      messageId,
      folder,
      // archive 的 UID 只在归档文件夹里有意义，带上用户配的 archive_folder 让 bridge 定位
      archiveFolder:
        folder === "archive"
          ? (this.account.archive_folder ?? undefined)
          : undefined,
    });
    const { rawEmail } = (await resp.json()) as { rawEmail: string };
    return base64ToArrayBuffer(rawEmail);
  }
}
