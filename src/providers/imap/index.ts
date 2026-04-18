import { getAccountById } from "@db/accounts";
import { type EmailListItem, EmailProvider } from "@providers/base";
import { callBridge } from "@providers/imap/utils";
import { base64ToArrayBuffer } from "@utils/base64url";
import { IMAP_FLAG_FLAGGED, IMAP_FLAG_SEEN } from "@/constants";
import type { Env } from "@/types";

export {
  checkImapBridgeHealth,
  syncAccounts,
} from "@providers/imap/utils";

export class ImapProvider extends EmailProvider {
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

  async listArchived(_maxResults: number = 20): Promise<EmailListItem[]> {
    // IMAP bridge 暂未支持按文件夹列邮件；待 bridge 加 /api/list-folder 后实现
    return [];
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
      folder: this.account.archive_folder ?? "Archive",
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
    folder?: "inbox" | "junk",
  ): Promise<ArrayBuffer> {
    const resp = await callBridge(this.env, "POST", "/api/fetch", {
      accountId: this.account.id,
      messageId,
      folder,
    });
    const { rawEmail } = (await resp.json()) as { rawEmail: string };
    return base64ToArrayBuffer(rawEmail);
  }
}
