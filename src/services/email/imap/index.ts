import { getAccountById } from "@db/accounts";
import { callBridge } from "@services/email/imap/utils";
import { EmailProvider } from "@services/email/provider";
import { IMAP_FLAG_FLAGGED, IMAP_FLAG_SEEN } from "@/constants";
import type { Env } from "@/types";

export {
  checkImapBridgeHealth,
  syncAccounts,
} from "@services/email/imap/utils";

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

  async markAsJunk(messageId: string) {
    await callBridge(this.env, "POST", "/api/mark-as-junk", {
      accountId: this.account.id,
      messageId,
    });
  }

  async moveToInbox(messageId: string) {
    await callBridge(this.env, "POST", "/api/move-to-inbox", {
      accountId: this.account.id,
      messageId,
    });
  }

  async trashMessage(messageId: string) {
    await callBridge(this.env, "POST", "/api/trash", {
      accountId: this.account.id,
      messageId,
    });
  }

  async trashAllJunk() {
    const resp = await callBridge(this.env, "POST", "/api/trash-all-junk", {
      accountId: this.account.id,
    });
    const { count } = (await resp.json()) as { count: number };
    return count;
  }

  /** 拉取单封邮件原文，返回 base64 编码的 RFC 2822 raw email */
  async fetchRawEmail(
    messageId: string,
    folder?: "inbox" | "junk",
  ): Promise<string> {
    const resp = await callBridge(this.env, "POST", "/api/fetch", {
      accountId: this.account.id,
      messageId,
      folder,
    });
    const { rawEmail } = (await resp.json()) as { rawEmail: string };
    return rawEmail;
  }
}
