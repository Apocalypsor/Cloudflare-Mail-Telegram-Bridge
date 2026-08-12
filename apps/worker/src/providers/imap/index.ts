import { WorkerImapClient } from "@worker/clients/imap";
import { quoteImapString } from "@worker/clients/imap/utils";
import { IMAP_FLAG_FLAGGED, IMAP_FLAG_SEEN } from "@worker/constants";
import { getAccountById } from "@worker/db/accounts";
import { EmailMessageNotFoundError } from "@worker/errors/email-provider";
import { EmailProvider } from "@worker/providers/base";
import { listImapPage } from "@worker/providers/imap/utils/list";
import {
  findArchiveFolder,
  findJunkFolder,
  findTrashFolder,
  mailboxExists,
  resolveArchiveFolder,
  resolveFolderForHint,
} from "@worker/providers/imap/utils/mailboxes";
import {
  buildMessagesFromHeaders,
  type DatedEmailListItem,
  sortByDateDesc,
} from "@worker/providers/imap/utils/messages";
import type {
  EmailCount,
  EmailListItem,
  EmailListPage,
  MessageState,
  RawEmailWithState,
} from "@worker/providers/types";
import type { Env, WaitUntil } from "@worker/types";
import { scheduleEmailDeliveries } from "@worker/utils/mail-delivery/dispatch";

/**
 * IMAP provider —— 所有 `messageId` 参数都是 RFC 822 Message-Id（全局唯一，跨 folder
 * 稳定）。不是 IMAP UID。Provider 会按 `SEARCH HEADER Message-Id` 在相关 folder
 * 里找到当前 UID 再操作。Cloudflare Email Routing 只负责推送 signal；真正的
 * 邮件读取/状态操作在 Worker 内按需打开短 IMAP 连接完成。
 */
export class ImapProvider extends EmailProvider {
  static displayName = "IMAP";

  // ─── Push dispatch ────────────────────────────────────────────────────

  /** 解析 Email Routing / IMAP signal 并安排后台投递。payload 里的 ID 是 RFC 822 Message-Id。 */
  static async dispatch(
    body: { accountId: number; rfcMessageId: string },
    env: Env,
    waitUntil: WaitUntil,
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
    scheduleEmailDeliveries(
      env,
      [{ accountId, emailMessageId: rfcMessageId }],
      waitUntil,
    );
  }

  // ─── Message actions ──────────────────────────────────────────────────

  /** archive folder 路径只在 hint 为 archive 时有意义 —— 跟 fetchRawEmail 一致 */
  private flagArchiveFolder(
    folder?: "inbox" | "junk" | "archive",
  ): string | undefined {
    return folder === "archive"
      ? (this.account.archive_folder ?? undefined)
      : undefined;
  }

  async markAsRead(messageId: string, folder?: "inbox" | "junk" | "archive") {
    await this.setFlag(messageId, IMAP_FLAG_SEEN, true, folder);
  }

  async addStar(messageId: string, folder?: "inbox" | "junk" | "archive") {
    await this.setFlag(messageId, IMAP_FLAG_FLAGGED, true, folder);
  }

  async removeStar(messageId: string, folder?: "inbox" | "junk" | "archive") {
    await this.setFlag(messageId, IMAP_FLAG_FLAGGED, false, folder);
  }

  async isStarred(messageId: string, folder?: "inbox" | "junk" | "archive") {
    return this.withClient(async (client) => {
      const resolved = await resolveFolderForHint(
        this.env,
        client,
        this.account.id,
        folder,
        this.flagArchiveFolder(folder),
      );
      if (resolved === null) return false;
      await client.selectMailbox(resolved);
      const uid = await this.findUidInSelectedMailbox(client, messageId);
      if (uid === null) return false;
      const flags = await client.fetchFlags(uid);
      return flags.some((flag) => flag.toLowerCase() === "\\flagged");
    });
  }

  /**
   * 按 RFC Message-Id 跨 folder 定位邮件。
   *
   * 不吞 error —— IMAP 瞬时不可达就直接抛给 `reconcileMessageState`，不会误删 TG。
   */
  async resolveMessageState(messageId: string): Promise<MessageState> {
    return this.withClient(async (client) => {
      await client.selectMailbox("INBOX");
      const inboxUid = await this.findUidInSelectedMailbox(client, messageId);
      if (inboxUid !== null) {
        const flags = await client.fetchFlags(inboxUid);
        return {
          location: "inbox",
          starred: flags.some((flag) => flag.toLowerCase() === "\\flagged"),
        };
      }

      const junkPath = await findJunkFolder(this.env, client, this.account.id);
      if (
        junkPath &&
        (await this.findUidByMessageId(client, junkPath, messageId)) !== null
      ) {
        return { location: "junk" };
      }

      const archivePath = await this.findExistingArchiveFolder(client);
      if (
        archivePath &&
        (await this.findUidByMessageId(client, archivePath, messageId)) !== null
      ) {
        return { location: "archive" };
      }

      const trashPath = await findTrashFolder(
        this.env,
        client,
        this.account.id,
      );
      if (
        trashPath &&
        (await this.findUidByMessageId(client, trashPath, messageId)) !== null
      ) {
        return { location: "deleted" };
      }

      return { location: "deleted" };
    });
  }

  async listUnread(maxResults: number = 20) {
    return this.searchAndFetch("INBOX", "UNSEEN", maxResults, 0);
  }

  async countUnread(): Promise<EmailCount> {
    return {
      count: await this.countSearchResults("INBOX", "UNSEEN"),
      truncated: false,
    };
  }

  async listUnreadPage(
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return listImapPage(maxResults, cursor, (limit, offset) =>
      this.searchAndFetch("INBOX", "UNSEEN", limit, offset),
    );
  }

  async listStarred(maxResults: number = 20) {
    return this.searchAndFetch("INBOX", "FLAGGED", maxResults, 0);
  }

  async listStarredPage(
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return listImapPage(maxResults, cursor, (limit, offset) =>
      this.searchAndFetch("INBOX", "FLAGGED", limit, offset),
    );
  }

  async listJunk(maxResults: number = 20) {
    return this.withClient(async (client) => {
      const junkPath = await findJunkFolder(this.env, client, this.account.id);
      if (!junkPath) return [];
      return this.searchAndFetchWithClient(
        client,
        junkPath,
        "ALL",
        maxResults,
        0,
      );
    });
  }

  async countJunk(): Promise<EmailCount> {
    const count = await this.withClient(async (client) => {
      const junkPath = await findJunkFolder(this.env, client, this.account.id);
      if (!junkPath) return 0;
      return this.countSearchResultsWithClient(client, junkPath, "ALL");
    });
    return { count, truncated: false };
  }

  async listJunkPage(
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return listImapPage(maxResults, cursor, (limit, offset) =>
      this.withClient(async (client) => {
        const junkPath = await findJunkFolder(
          this.env,
          client,
          this.account.id,
        );
        if (!junkPath) return [];
        return this.searchAndFetchWithClient(
          client,
          junkPath,
          "ALL",
          limit,
          offset,
        );
      }),
    );
  }

  async listArchived(maxResults: number = 20): Promise<EmailListItem[]> {
    return this.withClient(async (client) => {
      const archivePath = await this.findExistingArchiveFolder(client);
      if (!archivePath) return [];
      return this.searchAndFetchWithClient(
        client,
        archivePath,
        "ALL",
        maxResults,
        0,
      );
    });
  }

  async listArchivedPage(
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return listImapPage(maxResults, cursor, (limit, offset) =>
      this.withClient(async (client) => {
        const archivePath = await this.findExistingArchiveFolder(client);
        if (!archivePath) return [];
        return this.searchAndFetchWithClient(
          client,
          archivePath,
          "ALL",
          limit,
          offset,
        );
      }),
    );
  }

  async searchMessages(
    query: string,
    maxResults: number = 20,
  ): Promise<EmailListItem[]> {
    return this.searchMessagesWithOffset(query, maxResults, 0);
  }

  async searchMessagesPage(
    query: string,
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return listImapPage(maxResults, cursor, (limit, offset) =>
      this.searchMessagesWithOffset(query, limit, offset),
    );
  }

  async markAllAsRead(_maxResults?: number) {
    // IMAP 一条 STORE +\Seen 就把整 INBOX 未读全标了，maxResults 在这里被忽略。
    const count = await this.withClient(async (client) => {
      await client.selectMailbox("INBOX");
      const uids = await client.search("UNSEEN");
      await client.addFlags(uids, [IMAP_FLAG_SEEN]);
      return uids.length;
    });
    return { success: count, failed: 0 };
  }

  async markAsJunk(messageId: string) {
    await this.withClient(async (client) => {
      const junkPath = await findJunkFolder(this.env, client, this.account.id);
      if (!junkPath) throw new Error("IMAP junk folder not found");
      await client.selectMailbox("INBOX");
      const uid = await this.findUidInSelectedMailbox(client, messageId);
      if (uid === null)
        throw new Error(`Message-Id not in INBOX: ${messageId}`);
      await client.moveToFolder(uid, junkPath);
    });
  }

  /**
   * Junk → INBOX。Message-Id 不会因为 folder 移动而变，所以返回同一个 id。
   * 保持 abstract signature（Outlook/Gmail 会换 id）的 `Promise<string>`。
   */
  async moveToInbox(messageId: string): Promise<string> {
    await this.withClient(async (client) => {
      const junkPath = await findJunkFolder(this.env, client, this.account.id);
      if (!junkPath) throw new Error("IMAP junk folder not found");
      await client.selectMailbox(junkPath);
      const uid = await this.findUidInSelectedMailbox(client, messageId);
      if (uid === null)
        throw new Error(`Message-Id not in ${junkPath}: ${messageId}`);
      await client.moveToFolder(uid, "INBOX");
    });
    return messageId;
  }

  async unarchiveMessage(messageId: string): Promise<string> {
    await this.withClient(async (client) => {
      const archivePath = await resolveArchiveFolder(
        this.env,
        client,
        this.account.id,
        this.account.archive_folder ?? undefined,
      );
      await client.selectMailbox(archivePath);
      const uid = await this.findUidInSelectedMailbox(client, messageId);
      if (uid === null)
        throw new Error(`Message-Id not in ${archivePath}: ${messageId}`);
      await client.moveToFolder(uid, "INBOX");
    });
    return messageId;
  }

  async trashMessage(messageId: string) {
    await this.withClient(async (client) => {
      const [junkPath, archivePath, trashPath] = await Promise.all([
        findJunkFolder(this.env, client, this.account.id),
        findArchiveFolder(this.env, client, this.account.id),
        findTrashFolder(this.env, client, this.account.id),
      ]);
      const candidates = ["INBOX", junkPath, archivePath].filter(
        (folder): folder is string => !!folder,
      );
      const hit = await this.locateMessage(client, messageId, candidates);
      if (!hit) throw new Error(`Message-Id not found: ${messageId}`);

      await client.selectMailbox(hit.folder);
      if (trashPath) await client.moveToFolder(hit.uid, trashPath);
      else await client.deleteUid(hit.uid);
    });
  }

  async archiveMessage(messageId: string) {
    await this.withClient(async (client) => {
      const archivePath = this.account.archive_folder
        ? this.account.archive_folder
        : ((await findArchiveFolder(this.env, client, this.account.id)) ??
          "Archive");
      if (!(await mailboxExists(client, archivePath))) {
        await client.createMailbox(archivePath);
      }

      await client.selectMailbox("INBOX");
      const uid = await this.findUidInSelectedMailbox(client, messageId);
      if (uid === null)
        throw new Error(`Message-Id not in INBOX: ${messageId}`);
      await client.moveToFolder(uid, archivePath);
    });
  }

  async trashAllJunk() {
    return this.withClient(async (client) => {
      const junkPath = await findJunkFolder(this.env, client, this.account.id);
      if (!junkPath) return 0;
      const trashPath = await findTrashFolder(
        this.env,
        client,
        this.account.id,
      );
      await client.selectMailbox(junkPath);
      const uids = await client.search("ALL");
      if (uids.length === 0) return 0;
      if (trashPath) {
        for (const uid of uids) await client.moveToFolder(uid, trashPath);
      } else {
        for (const uid of uids) await client.deleteUid(uid);
      }
      return uids.length;
    });
  }

  /** 通过 Worker-native IMAP 拉取单封邮件原文，返回 ArrayBuffer */
  async fetchRawEmail(
    messageId: string,
    folder?: "inbox" | "junk" | "archive",
  ): Promise<ArrayBuffer> {
    return this.withClient(async (client) => {
      const resolved = await resolveFolderForHint(
        this.env,
        client,
        this.account.id,
        folder,
        this.flagArchiveFolder(folder),
      );
      if (resolved === null) {
        throw new Error(`IMAP folder not found for hint=${folder}`);
      }
      await client.selectMailbox(resolved);
      const uid = await this.findUidInSelectedMailbox(client, messageId);
      if (uid === null) {
        throw new Error(`Message-Id not found in ${resolved}: ${messageId}`);
      }
      return client.fetchRaw(uid);
    });
  }

  async fetchRawEmailWithState(messageId: string): Promise<RawEmailWithState> {
    return this.withClient(async (client) => {
      await client.selectMailbox("INBOX");
      const uid = await this.findUidInSelectedMailbox(client, messageId);
      if (uid === null) {
        throw new EmailMessageNotFoundError(messageId, "INBOX");
      }
      const { rawEmail, flags } = await client.fetchRawAndFlags(uid);
      return {
        rawEmail,
        state: {
          location: "inbox",
          starred: flags.some((flag) => flag.toLowerCase() === "\\flagged"),
        },
      };
    });
  }

  private async setFlag(
    messageId: string,
    flag: string,
    add: boolean,
    folder?: "inbox" | "junk" | "archive",
  ): Promise<void> {
    await this.withClient(async (client) => {
      const resolved = await resolveFolderForHint(
        this.env,
        client,
        this.account.id,
        folder,
        this.flagArchiveFolder(folder),
      );
      if (resolved === null) return;
      await client.selectMailbox(resolved);
      const uid = await this.findUidInSelectedMailbox(client, messageId);
      if (uid === null) return;
      if (add) await client.addFlags([uid], [flag]);
      else await client.removeFlags([uid], [flag]);
    });
  }

  private async searchAndFetch(
    folder: string,
    criteria: string,
    maxResults: number,
    offset: number,
  ): Promise<DatedEmailListItem[]> {
    return this.withClient((client) =>
      this.searchAndFetchWithClient(
        client,
        folder,
        criteria,
        maxResults,
        offset,
      ),
    );
  }

  private async searchAndFetchWithClient(
    client: WorkerImapClient,
    folder: string,
    criteria: string,
    maxResults: number,
    offset: number,
  ): Promise<DatedEmailListItem[]> {
    await client.selectMailbox(folder);
    const uids = (await client.search(criteria))
      .sort((a, b) => b - a)
      .slice(offset, offset + maxResults);
    const blocks = await client.fetchHeaderBlocks(uids);
    return buildMessagesFromHeaders(blocks);
  }

  private async countSearchResults(
    folder: string,
    criteria: string,
  ): Promise<number> {
    return this.withClient((client) =>
      this.countSearchResultsWithClient(client, folder, criteria),
    );
  }

  private async countSearchResultsWithClient(
    client: WorkerImapClient,
    folder: string,
    criteria: string,
  ): Promise<number> {
    await client.selectMailbox(folder);
    return (await client.search(criteria)).length;
  }

  private async findExistingArchiveFolder(
    client: WorkerImapClient,
  ): Promise<string | null> {
    if (!this.account.archive_folder) {
      return findArchiveFolder(this.env, client, this.account.id);
    }
    return (await mailboxExists(client, this.account.archive_folder))
      ? this.account.archive_folder
      : null;
  }

  private async searchMessagesWithOffset(
    query: string,
    maxResults: number,
    offset: number,
  ): Promise<EmailListItem[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    return this.withClient(async (client) => {
      const [junkPath, archivePath] = await Promise.all([
        findJunkFolder(this.env, client, this.account.id),
        findArchiveFolder(this.env, client, this.account.id),
      ]);
      const folders = ["INBOX", junkPath, archivePath]
        .filter((folder): folder is string => !!folder)
        .filter((folder, index, all) => all.indexOf(folder) === index);

      const all: DatedEmailListItem[] = [];
      for (const folder of folders) {
        all.push(
          ...(await this.searchAndFetchWithClient(
            client,
            folder,
            `TEXT ${quoteImapString(trimmed)}`,
            offset + maxResults,
            0,
          )),
        );
      }

      const seen = new Set<string>();
      const dedup = all.filter((message) => {
        if (seen.has(message.id)) return false;
        seen.add(message.id);
        return true;
      });
      return sortByDateDesc(dedup).slice(offset, offset + maxResults);
    });
  }

  private async locateMessage(
    client: WorkerImapClient,
    messageId: string,
    folders: string[],
  ): Promise<{ folder: string; uid: number } | null> {
    for (const folder of folders) {
      const uid = await this.findUidByMessageId(client, folder, messageId);
      if (uid !== null) return { folder, uid };
    }
    return null;
  }

  private async findUidByMessageId(
    client: WorkerImapClient,
    folder: string,
    messageId: string,
  ): Promise<number | null> {
    await client.selectMailbox(folder);
    return this.findUidInSelectedMailbox(client, messageId);
  }

  private async findUidInSelectedMailbox(
    client: WorkerImapClient,
    messageId: string,
  ): Promise<number | null> {
    const hits = await client.search(
      `HEADER Message-ID ${quoteImapString(messageId)}`,
    );
    if (hits.length === 0) return null;
    return hits.sort((a, b) => b - a)[0] ?? null;
  }

  private async withClient<T>(
    fn: (client: WorkerImapClient) => Promise<T>,
  ): Promise<T> {
    const client = await WorkerImapClient.connect(this.account);
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }
}
