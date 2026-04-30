import type { Account, AccountType } from "@worker/types";

export async function getAllAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db
    .prepare("SELECT * FROM accounts ORDER BY id")
    .all<Account>();
  return results;
}

export async function getAccountById(
  db: D1Database,
  id: number,
): Promise<Account | null> {
  return db
    .prepare("SELECT * FROM accounts WHERE id = ?")
    .bind(id)
    .first<Account>();
}

/** 获取所有使用该 email 的账号（同一邮箱可绑定多个账号） */
export async function getAccountsByEmail(
  db: D1Database,
  email: string,
): Promise<Account[]> {
  const { results } = await db
    .prepare("SELECT * FROM accounts WHERE email = ? ORDER BY id")
    .bind(email)
    .all<Account>();
  return results;
}

/** 获取用户自己绑定的账号 */
export async function getOwnAccounts(
  db: D1Database,
  telegramUserId: string,
): Promise<Account[]> {
  const { results } = await db
    .prepare("SELECT * FROM accounts WHERE telegram_user_id = ? ORDER BY id")
    .bind(telegramUserId)
    .all<Account>();
  return results;
}

/** 获取用户可见的账号：admin 看全部，普通用户看自己绑定的 */
export async function getVisibleAccounts(
  db: D1Database,
  telegramUserId: string,
  isAdmin: boolean,
): Promise<Account[]> {
  if (isAdmin) return getAllAccounts(db);
  return getOwnAccounts(db, telegramUserId);
}

/** 检查用户是否有权访问指定账号，返回账号或 null */
export async function getAuthorizedAccount(
  db: D1Database,
  id: number,
  userId: string,
  isAdmin: boolean,
): Promise<Account | null> {
  const account = await getAccountById(db, id);
  if (!account) return null;
  if (isAdmin) return account;
  if (account.telegram_user_id === userId) return account;
  return null;
}

export async function createAccount(
  db: D1Database,
  chatId: string,
  telegramUserId: string | undefined,
  type: AccountType,
): Promise<Account> {
  const result = await db
    .prepare(
      "INSERT INTO accounts (type, chat_id, telegram_user_id) VALUES (?, ?, ?) RETURNING *",
    )
    .bind(type, chatId, telegramUserId ?? null)
    .first<Account>();
  if (!result) throw new Error("Failed to create account");
  return result;
}

export async function deleteAccount(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
}

export async function updateRefreshToken(
  db: D1Database,
  id: number,
  refreshToken: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE accounts SET refresh_token = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(refreshToken, id)
    .run();
}

export async function updateAccountEmail(
  db: D1Database,
  id: number,
  email: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE accounts SET email = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(email, id)
    .run();
}

export async function updateAccount(
  db: D1Database,
  id: number,
  chatId: string,
  telegramUserId?: string | null,
): Promise<void> {
  if (telegramUserId !== undefined) {
    await db
      .prepare(
        "UPDATE accounts SET chat_id = ?, telegram_user_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(chatId, telegramUserId, id)
      .run();
  } else {
    await db
      .prepare(
        "UPDATE accounts SET chat_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(chatId, id)
      .run();
  }
}

/** 获取所有启用状态的 IMAP 账号（供中间件拉取，disabled 账号会被跳过） */
export async function getImapAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM accounts WHERE type = 'imap' AND disabled = 0 ORDER BY id",
    )
    .all<Account>();
  return results;
}

/** 切换账号启用 / 禁用状态 */
export async function setAccountDisabled(
  db: D1Database,
  accountId: number,
  disabled: boolean,
): Promise<void> {
  await db
    .prepare(
      "UPDATE accounts SET disabled = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(disabled ? 1 : 0, accountId)
    .run();
}

// ─── History ID ─────────────────────────────────────────────────────────────

export async function getHistoryId(
  db: D1Database,
  accountId: number,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT history_id FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ history_id: string | null }>();
  return row?.history_id ?? null;
}

export async function putHistoryId(
  db: D1Database,
  accountId: number,
  historyId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE accounts SET history_id = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(historyId, accountId)
    .run();
}

// ─── Archive Folder ──────────────────────────────────────────────────────────

export async function setArchiveFolder(
  db: D1Database,
  accountId: number,
  archiveFolder: string | null,
  archiveFolderName: string | null,
): Promise<void> {
  await db
    .prepare(
      "UPDATE accounts SET archive_folder = ?, archive_folder_name = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(archiveFolder, archiveFolderName, accountId)
    .run();
}

/** 创建 IMAP 账号 */
export async function createImapAccount(
  db: D1Database,
  params: {
    chatId: string;
    telegramUserId?: string;
    email: string;
    imapHost: string;
    imapPort: number;
    imapSecure: number;
    imapUser: string;
    imapPass: string;
  },
): Promise<Account> {
  const result = await db
    .prepare(
      "INSERT INTO accounts (type, chat_id, telegram_user_id, email, imap_host, imap_port, imap_secure, imap_user, imap_pass) VALUES ('imap', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(
      params.chatId,
      params.telegramUserId ?? null,
      params.email,
      params.imapHost,
      params.imapPort,
      params.imapSecure,
      params.imapUser,
      params.imapPass,
    )
    .first<Account>();
  if (!result) throw new Error("Failed to create IMAP account");
  return result;
}
