import { getAccountById, getImapAccounts } from "@db/accounts";
import { getMappingsByEmailIds } from "@db/message-map";
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

  /**
   * 问 bridge 这封邮件现在是不是在 junk folder。用 RFC Message-Id 做跨 folder 精确
   * 检查：UID 在 junk folder 里对不上，用 Message-Id `SEARCH HEADER` 才准。
   *
   * 历史 mapping 可能没存 Message-Id（migration 0020 之前的数据 / 原邮件无 Message-Id 头），
   * 此时保守返回 false —— 比让调用方（预览页）误判为 junk 要安全。
   */
  async isJunk(messageId: string) {
    const mappings = await getMappingsByEmailIds(this.env.DB, this.account.id, [
      messageId,
    ]);
    const rfcMessageId = mappings[0]?.rfc_message_id;
    if (!rfcMessageId) return false;

    const resp = await callBridge(this.env, "POST", "/api/is-junk", {
      accountId: this.account.id,
      rfcMessageId,
    });
    const { junk } = (await resp.json()) as { junk: boolean };
    return junk;
  }

  /**
   * IMAP UID 是 per-folder 的，邮件移出 INBOX 后 UID 失效 —— 要跨 folder 对账必须
   * 用 RFC 822 Message-Id（全局唯一）。
   *
   * 策略：
   *  - 有 `rfcMessageId` → 调 bridge `/api/locate`，按 Message-Id 在 junk / archive /
   *    trash / INBOX 各文件夹 SEARCH HEADER，精确返回当前位置
   *  - 没有（历史 mapping 里为 NULL）→ 回退到 `/api/is-junk` + `/api/is-starred`；
   *    只能分辨 junk / inbox，无法区分 archive / deleted（遗留限制）
   *
   * 不吞 error —— bridge 瞬时不可达就直接抛给 `reconcileMessageState`，不会误删 TG。
   */
  async resolveMessageState(
    messageId: string,
    rfcMessageId?: string | null,
  ): Promise<MessageState> {
    if (rfcMessageId) {
      const resp = await callBridge(this.env, "POST", "/api/locate", {
        accountId: this.account.id,
        rfcMessageId,
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

    // 兼容回退：历史 mapping 没有 Message-Id
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
