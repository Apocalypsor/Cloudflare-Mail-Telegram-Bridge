import type { ActiveConnection, Connection } from "@middleware/imap/types";
import { getLastUid, setLastUid } from "@middleware/utils/redis";
import {
  fetchImapAccounts,
  type ImapAccount,
  notifyNewEmail,
} from "@middleware/utils/telemail-client";
import { type ExistsEvent, ImapFlow } from "imapflow";
import { RECONNECT_DELAY_MS, REFRESH_INTERVAL_MS } from "../constants";

class ImapConnectionManager {
  private connections = new Map<number, Connection>();
  private reconnectTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private refreshTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private connecting = new Set<number>();

  getConnection(accountId: number): Connection | undefined {
    return this.connections.get(accountId);
  }

  requireConnection(accountId: number, caller: string): ActiveConnection {
    const conn = this.connections.get(accountId);
    if (!conn || !conn.client) {
      throw new Error(`[Account ${accountId}] ${caller}: no active connection`);
    }

    return conn as ActiveConnection;
  }

  sync = async (): Promise<void> => {
    console.log("[ImapManager] Syncing accounts from Telemail...");
    const accounts = await fetchImapAccounts();
    const incomingIds = new Set(accounts.map((a) => a.id));

    for (const id of this.connections.keys()) {
      if (!incomingIds.has(id)) await this.stopConnection(id);
    }

    for (const account of accounts) {
      const existing = this.connections.get(account.id);
      if (existing) {
        if (!this.configChanged(existing.account, account)) continue;
        console.log(`[Account ${account.id}] Config changed, restarting`);
        await this.stopConnection(account.id);
      }
      await this.startConnection(account);
    }

    console.log(
      `[ImapManager] Active: ${[...this.connections.keys()].join(", ") || "none"}`,
    );
  };

  health = (): { ok: boolean; total: number; usable: number } => {
    const conns = [...this.connections.values()];
    const usable = conns.filter((c) => c.active && c.client?.usable).length;
    const ok = conns.length === 0 || usable > 0;
    return { ok, total: conns.length, usable };
  };

  list = (): { id: number; email: string; active: boolean }[] =>
    [...this.connections.values()].map((c) => ({
      id: c.account.id,
      email: c.account.email,
      active: c.active,
    }));

  // ---------------------------------------------------------------------------

  private configChanged = (a: ImapAccount, b: ImapAccount): boolean =>
    a.imap_host !== b.imap_host ||
    a.imap_port !== b.imap_port ||
    a.imap_secure !== b.imap_secure ||
    a.imap_user !== b.imap_user ||
    a.imap_pass !== b.imap_pass;

  private stopConnection = async (id: number): Promise<void> => {
    const conn = this.connections.get(id);
    if (!conn) return;
    conn.active = false;
    this.clearTimer(this.reconnectTimers, id);
    this.clearTimer(this.refreshTimers, id);
    this.connections.delete(id);
    await conn.client?.logout().catch(() => {});
    console.log(`[Account ${id}] Stopped`);
  };

  private startConnection = async (account: ImapAccount): Promise<void> => {
    const cachedUid = await getLastUid(account.id);
    const conn: Connection = {
      account,
      client: null,
      active: true,
      lastUid: cachedUid ?? 0,
    };
    if (cachedUid !== null) {
      console.log(
        `[Account ${account.id}] Restored lastUid from Redis: ${cachedUid}`,
      );
    }
    this.connections.set(account.id, conn);
    await this.connect(conn);
  };

  private clearTimer = (
    timers: Map<number, ReturnType<typeof setTimeout>>,
    id: number,
  ): void => {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  };

  private scheduleReconnect = (conn: Connection): void => {
    if (!conn.active) return;
    if (this.reconnectTimers.has(conn.account.id)) return;

    console.log(
      `[Account ${conn.account.id}] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`,
    );
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(conn.account.id);
      this.connect(conn);
    }, RECONNECT_DELAY_MS);
    this.reconnectTimers.set(conn.account.id, timer);
  };

  private scheduleRefresh = (conn: Connection): void => {
    this.clearTimer(this.refreshTimers, conn.account.id);
    const timer = setTimeout(() => {
      this.refreshTimers.delete(conn.account.id);
      this.refreshConnection(conn);
    }, REFRESH_INTERVAL_MS);
    this.refreshTimers.set(conn.account.id, timer);
  };

  private refreshConnection = async (conn: Connection): Promise<void> => {
    if (!conn.active) return;
    console.log(
      `[Account ${conn.account.id}] Periodic refresh, reconnecting...`,
    );
    // Clear any pending reconnect to prevent double-connect
    this.clearTimer(this.reconnectTimers, conn.account.id);
    const oldClient = conn.client;
    conn.client = null;
    // Fire-and-forget: don't await logout — the connection may be stuck (the
    // very reason we refresh). The old socket will close on its own timeout.
    oldClient?.logout().catch(() => {});
    await this.connect(conn);
  };

  private connect = async (conn: Connection): Promise<void> => {
    if (!conn.active) return;
    const id = conn.account.id;
    if (this.connecting.has(id)) return;
    this.connecting.add(id);

    try {
      conn.client = new ImapFlow({
        host: conn.account.imap_host,
        port: conn.account.imap_port,
        secure: conn.account.imap_secure,
        auth: { user: conn.account.imap_user, pass: conn.account.imap_pass },
        logger: false, // Disable imapflow's internal logging
        // For servers without IDLE, ImapFlow polls every 2 min. STATUS is the
        // most reliable fallback: NOOP relies on the server pushing untagged
        // EXISTS responses (not all do), and SELECT has a known loop issue.
        missingIdleCommand: "STATUS",
      });

      await conn.client.connect();

      // Capture reference so stale event handlers from old clients are ignored
      const client = conn.client;

      const lock = await client.getMailboxLock("INBOX");
      try {
        if (conn.lastUid === 0) {
          const mailbox = client.mailbox || undefined;
          conn.lastUid = (mailbox?.uidNext ?? 1) - 1;
        } else {
          conn.lastUid = await this.fetchNewMessages(conn, conn.lastUid);
        }
        await setLastUid(conn.account.id, conn.lastUid);
      } finally {
        lock.release();
      }

      console.log(
        `[Account ${id}] Connected to ${conn.account.imap_host} | watching from UID > ${conn.lastUid}`,
      );

      // Schedule periodic refresh to prevent IDLE stalls (e.g. iCloud)
      this.scheduleRefresh(conn);

      client.on("exists", async (data: ExistsEvent) => {
        if (!conn.active || conn.client !== client) return;
        if (data.count <= data.prevCount) return;

        try {
          const lock = await client.getMailboxLock("INBOX");
          try {
            conn.lastUid = await this.fetchNewMessages(conn, conn.lastUid);
            await setLastUid(id, conn.lastUid);
          } finally {
            lock.release();
          }
        } catch (err: unknown) {
          if (!conn.active) return;
          console.error(
            `[Account ${id}] exists handler error:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      });

      client.on("error", (err: Error) => {
        if (!conn.active || conn.client !== client) return;
        console.error(`[Account ${id}] IMAP error:`, err.message);
      });

      client.on("close", () => {
        if (!conn.active || conn.client !== client) return;
        conn.client = null;
        this.clearTimer(this.refreshTimers, id);
        console.log(
          `[Account ${id}] Connection closed, scheduling reconnect...`,
        );
        this.scheduleReconnect(conn);
      });
    } catch (err: unknown) {
      if (!conn.active) return;
      console.error(
        `[Account ${id}] Connection error:`,
        err instanceof Error ? err.message : String(err),
      );
      try {
        await conn.client?.logout();
        conn.client = null;
      } catch {}
      this.scheduleReconnect(conn);
    } finally {
      this.connecting.delete(id);
    }
  };

  private fetchNewMessages = async (
    conn: Connection,
    lastUid: number,
  ): Promise<number> => {
    let newLastUid = lastUid;
    try {
      if (!conn.client) return newLastUid;

      // 拉 envelope 取 Message-Id 作为通知 payload —— worker 以 RFC Message-Id 为
      // 邮件全局唯一标识，per-folder 的 UID 移出 INBOX 后就失效了
      for await (const msg of conn.client.fetch(
        `${lastUid + 1}:*`,
        { uid: true, envelope: true },
        { uid: true },
      )) {
        if (msg.uid <= lastUid) continue;
        newLastUid = Math.max(newLastUid, msg.uid);

        const rfcMessageId = msg.envelope?.messageId;
        if (!rfcMessageId) {
          console.warn(
            `[Account ${conn.account.id}] UID ${msg.uid} has no Message-Id, skipping notify`,
          );
          continue;
        }

        console.log(
          `[Account ${conn.account.id}] New email UID ${msg.uid} (${rfcMessageId}), notifying Worker...`,
        );
        notifyNewEmail(conn.account.id, rfcMessageId).catch((err: unknown) => {
          console.error(
            `[Account ${conn.account.id}] Notify failed after retries (UID ${msg.uid}):`,
            err,
          );
        });
      }
      return newLastUid;
    } catch (err: unknown) {
      console.error(
        `[Account ${conn.account.id}] fetchNewMessages error:`,
        err instanceof Error ? err.message : err,
      );
      return newLastUid;
    }
  };
}

export const connectionManager = new ImapConnectionManager();
