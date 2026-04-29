/** message_map: Telegram 消息 ↔ 邮件消息映射 */

export interface MessageMapping {
  tg_message_id: number;
  tg_chat_id: string;
  /**
   * Provider 的邮件全局 id：Gmail messageId / Outlook Graph id / IMAP 的 RFC 822
   * Message-Id（不是 per-folder UID）。对 IMAP 而言跨 folder 稳定。
   */
  email_message_id: string;
  account_id: number;
  /** LLM 生成的一句话摘要，用于邮件列表显示（NULL = 未分析，列表回退到 subject） */
  short_summary: string | null;
}

/** 保存 Telegram → 邮件消息映射，返回是否实际插入（false = 重复，被 IGNORE） */
export async function putMessageMapping(
  db: D1Database,
  mapping: Pick<
    MessageMapping,
    "tg_message_id" | "tg_chat_id" | "email_message_id" | "account_id"
  >,
): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO message_map (tg_message_id, tg_chat_id, email_message_id, account_id) VALUES (?, ?, ?, ?)",
    )
    .bind(
      mapping.tg_message_id,
      mapping.tg_chat_id,
      mapping.email_message_id,
      mapping.account_id,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** 根据 Telegram 消息查找对应的邮件消息 */
export async function getMessageMapping(
  db: D1Database,
  chatId: string,
  tgMessageId: number,
): Promise<MessageMapping | null> {
  return db
    .prepare(
      "SELECT * FROM message_map WHERE tg_chat_id = ? AND tg_message_id = ?",
    )
    .bind(chatId, tgMessageId)
    .first<MessageMapping>();
}

/** 根据邮件 ID 列表批量查找对应的 Telegram 消息映射 */
export async function getMappingsByEmailIds(
  db: D1Database,
  accountId: number,
  emailMessageIds: string[],
): Promise<MessageMapping[]> {
  if (emailMessageIds.length === 0) return [];
  const placeholders = emailMessageIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT * FROM message_map WHERE account_id = ? AND email_message_id IN (${placeholders})`,
    )
    .bind(accountId, ...emailMessageIds)
    .all<MessageMapping>();
  return results;
}

/** 删除指定账号的所有消息映射 */
export async function deleteMappingsByAccountId(
  db: D1Database,
  accountId: number,
): Promise<void> {
  await db
    .prepare("DELETE FROM message_map WHERE account_id = ?")
    .bind(accountId)
    .run();
}

/** 删除单封邮件的映射 —— TG 消息被用户从聊天里删了（或失效），需要让
 *  `deliverEmailToTelegram` 重新投递时不要被 `(chat_id, email_message_id,
 *  account_id)` 唯一索引挡住。 */
export async function deleteMessageMapping(
  db: D1Database,
  accountId: number,
  emailMessageId: string,
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM message_map WHERE account_id = ? AND email_message_id = ?",
    )
    .bind(accountId, emailMessageId)
    .run();
}

/** 更新邮件 short_summary（LLM 分析成功后调用） */
export async function updateShortSummary(
  db: D1Database,
  accountId: number,
  emailMessageId: string,
  shortSummary: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE message_map SET short_summary = ? WHERE account_id = ? AND email_message_id = ?",
    )
    .bind(shortSummary, accountId, emailMessageId)
    .run();
}

/** 删除单条消息映射（垃圾邮件删除后清理） */
export async function deleteMappingByEmailId(
  db: D1Database,
  emailMessageId: string,
  accountId: number,
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM message_map WHERE email_message_id = ? AND account_id = ?",
    )
    .bind(emailMessageId, accountId)
    .run();
}
