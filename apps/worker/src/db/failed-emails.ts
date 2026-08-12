/** failed_emails: 失败邮件记录（LLM 摘要失败时保存，管理员可手动重试） */
import { getDb } from "@worker/db/client";
import { failedEmails } from "@worker/db/schema";
import { count, desc, eq } from "drizzle-orm";

/** 保存失败邮件记录（UPSERT：相同 email_message_id + tg_message_id 则更新） */
export const putFailedEmail = async (
  d1: D1Database,
  data: Omit<FailedEmail, "id" | "created_at">,
): Promise<void> => {
  const db = getDb(d1);
  const now = new Date();
  await db
    .insert(failedEmails)
    .values({
      account_id: data.account_id,
      email_message_id: data.email_message_id,
      tg_chat_id: data.tg_chat_id,
      tg_message_id: data.tg_message_id,
      subject: data.subject ?? null,
      error_message: data.error_message ?? null,
      created_at: now,
    })
    .onConflictDoUpdate({
      target: [failedEmails.email_message_id, failedEmails.tg_message_id],
      set: { error_message: data.error_message ?? null, created_at: now },
    });
};

/** 获取所有失败邮件（按创建时间倒序） */
export const getAllFailedEmails = async (
  d1: D1Database,
): Promise<FailedEmail[]> => {
  const db = getDb(d1);
  return db.select().from(failedEmails).orderBy(desc(failedEmails.created_at));
};

/** 获取单条失败邮件 */
export const getFailedEmail = async (
  d1: D1Database,
  id: number,
): Promise<FailedEmail | null> => {
  const db = getDb(d1);
  const [row] = await db
    .select()
    .from(failedEmails)
    .where(eq(failedEmails.id, id));
  return row ?? null;
};

/** 删除单条失败邮件记录 */
export const deleteFailedEmail = async (
  d1: D1Database,
  id: number,
): Promise<void> => {
  const db = getDb(d1);
  await db.delete(failedEmails).where(eq(failedEmails.id, id));
};

/** 清空所有失败邮件记录 */
export const deleteAllFailedEmails = async (d1: D1Database): Promise<void> => {
  const db = getDb(d1);
  await db.delete(failedEmails);
};

/** 删除指定账号的所有失败邮件记录 */
export const deleteFailedEmailsByAccountId = async (
  d1: D1Database,
  accountId: number,
): Promise<void> => {
  const db = getDb(d1);
  await db.delete(failedEmails).where(eq(failedEmails.account_id, accountId));
};

/** 统计失败邮件数量 */
export const countFailedEmails = async (d1: D1Database): Promise<number> => {
  const db = getDb(d1);
  const [row] = await db.select({ cnt: count() }).from(failedEmails);
  return row?.cnt ?? 0;
};
export type FailedEmail = typeof failedEmails.$inferSelect;
