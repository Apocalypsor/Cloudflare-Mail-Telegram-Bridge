/** message_map: Telegram 消息 ↔ 邮件消息映射 */

export interface MessageMapping {
  tg_message_id: number;
  tg_chat_id: string;
  email_message_id: string;
  account_id: number;
  /** LLM 生成的一句话摘要，用于邮件列表显示（NULL = 未分析，列表回退到 subject） */
  short_summary: string | null;
  /**
   * RFC 822 Message-Id header（全局唯一）。仅 IMAP 对账用：`email_message_id`
   * 在 IMAP 里是 per-folder 的 INBOX UID，邮件移出 INBOX 后失效；用 Message-Id
   * 可以让 middleware 跨 folder `SEARCH HEADER Message-Id` 定位当前位置。
   * Gmail/Outlook 忽略此字段。历史 mapping / 无 Message-Id 头的邮件为 NULL。
   */
  rfc_message_id: string | null;
}

/** 保存 Telegram → 邮件消息映射，返回是否实际插入（false = 重复，被 IGNORE） */
export async function putMessageMapping(
  db: D1Database,
  mapping: Pick<
    MessageMapping,
    | "tg_message_id"
    | "tg_chat_id"
    | "email_message_id"
    | "account_id"
    | "rfc_message_id"
  >,
): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO message_map (tg_message_id, tg_chat_id, email_message_id, account_id, rfc_message_id) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      mapping.tg_message_id,
      mapping.tg_chat_id,
      mapping.email_message_id,
      mapping.account_id,
      mapping.rfc_message_id,
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
