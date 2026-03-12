/** failed_emails: 失败邮件记录（LLM 摘要失败时保存，管理员可手动重试） */

export interface FailedEmail {
	id: number;
	account_id: number;
	email_message_id: string;
	tg_chat_id: string;
	tg_message_id: number;
	is_caption: number;
	subject: string | null;
	error_message: string | null;
	created_at: string;
}

/** 保存失败邮件记录（UPSERT：相同 email_message_id + tg_message_id 则更新） */
export async function putFailedEmail(
	db: D1Database,
	data: Omit<FailedEmail, 'id' | 'created_at'>,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO failed_emails (account_id, email_message_id, tg_chat_id, tg_message_id, is_caption, subject, error_message)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (email_message_id, tg_message_id) DO UPDATE SET
			   error_message = excluded.error_message,
			   created_at = datetime('now')`,
		)
		.bind(data.account_id, data.email_message_id, data.tg_chat_id, data.tg_message_id, data.is_caption, data.subject ?? null, data.error_message ?? null)
		.run();
}

/** 获取所有失败邮件（按创建时间倒序） */
export async function getAllFailedEmails(db: D1Database): Promise<FailedEmail[]> {
	const { results } = await db.prepare('SELECT * FROM failed_emails ORDER BY created_at DESC').all<FailedEmail>();
	return results;
}

/** 获取单条失败邮件 */
export async function getFailedEmail(db: D1Database, id: number): Promise<FailedEmail | null> {
	return db.prepare('SELECT * FROM failed_emails WHERE id = ?').bind(id).first<FailedEmail>();
}

/** 删除单条失败邮件记录 */
export async function deleteFailedEmail(db: D1Database, id: number): Promise<void> {
	await db.prepare('DELETE FROM failed_emails WHERE id = ?').bind(id).run();
}

/** 清空所有失败邮件记录 */
export async function deleteAllFailedEmails(db: D1Database): Promise<void> {
	await db.prepare('DELETE FROM failed_emails').run();
}

/** 统计失败邮件数量 */
export async function countFailedEmails(db: D1Database): Promise<number> {
	const row = await db.prepare('SELECT COUNT(*) as cnt FROM failed_emails').first<{ cnt: number }>();
	return row?.cnt ?? 0;
}
