/** D1 reminders 表记录 */
export interface Reminder {
  id: number;
  telegram_user_id: string;
  text: string;
  /** ISO 8601 UTC */
  remind_at: string;
  /** 邮件上下文（NULL = 通用提醒） */
  account_id: number | null;
  email_message_id: string | null;
  email_subject: string | null;
  tg_chat_id: string | null;
  tg_message_id: number | null;
  sent_at: string | null;
  created_at: string;
}

/** 创建提醒的输入：邮件上下文五个字段同时为 NULL = 通用提醒；同时 set = 邮件提醒 */
export interface CreateReminderInput {
  telegramUserId: string;
  text: string;
  remindAtIso: string;
  /** 以下五个字段绑定一封邮件；要么全 set，要么全 omit */
  accountId?: number;
  emailMessageId?: string;
  emailSubject?: string;
  tgChatId?: string;
  tgMessageId?: number;
}

/** 创建提醒，返回新行 id */
export async function createReminder(
  db: D1Database,
  input: CreateReminderInput,
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO reminders (
        telegram_user_id, text, remind_at,
        account_id, email_message_id, email_subject, tg_chat_id, tg_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.telegramUserId,
      input.text,
      input.remindAtIso,
      input.accountId ?? null,
      input.emailMessageId ?? null,
      input.emailSubject ?? null,
      input.tgChatId ?? null,
      input.tgMessageId ?? null,
    )
    .run();
  return Number(result.meta.last_row_id);
}

/** 列出某用户所有待发送提醒，按时间升序 */
export async function listPendingReminders(
  db: D1Database,
  telegramUserId: string,
): Promise<Reminder[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM reminders WHERE telegram_user_id = ? AND sent_at IS NULL ORDER BY remind_at ASC`,
    )
    .bind(telegramUserId)
    .all<Reminder>();
  return results;
}

/** 删除某用户的待发送提醒（不允许删别人的，所以 WHERE 双重约束） */
export async function deletePendingReminder(
  db: D1Database,
  telegramUserId: string,
  id: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM reminders WHERE id = ? AND telegram_user_id = ? AND sent_at IS NULL`,
    )
    .bind(id, telegramUserId)
    .run();
  return result.meta.changes > 0;
}

/** 取所有 remind_at <= nowIso 的待发送提醒（cron 调用） */
export async function listDueReminders(
  db: D1Database,
  nowIso: string,
  limit = 200,
): Promise<Reminder[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM reminders WHERE sent_at IS NULL AND remind_at <= ? ORDER BY remind_at ASC LIMIT ?`,
    )
    .bind(nowIso, limit)
    .all<Reminder>();
  return results;
}

/** 标记提醒已发送 */
export async function markReminderSent(
  db: D1Database,
  id: number,
): Promise<void> {
  await db
    .prepare(`UPDATE reminders SET sent_at = datetime('now') WHERE id = ?`)
    .bind(id)
    .run();
}

/** 统计某用户待发送提醒数量（用于上限保护） */
export async function countPendingReminders(
  db: D1Database,
  telegramUserId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM reminders WHERE telegram_user_id = ? AND sent_at IS NULL`,
    )
    .bind(telegramUserId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
