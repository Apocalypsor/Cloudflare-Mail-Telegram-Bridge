/** message_map: Telegram 消息 ↔ 邮件消息映射 */

export interface MessageMapping {
	tg_message_id: number;
	tg_chat_id: string;
	email_message_id: string;
	account_id: number;
	starred: number; // 0 = 未星标, 1 = 已星标
}

/** 保存 Telegram → 邮件消息映射 */
export async function putMessageMapping(db: D1Database, mapping: Omit<MessageMapping, 'starred'>): Promise<void> {
	await db
		.prepare('INSERT OR IGNORE INTO message_map (tg_message_id, tg_chat_id, email_message_id, account_id) VALUES (?, ?, ?, ?)')
		.bind(mapping.tg_message_id, mapping.tg_chat_id, mapping.email_message_id, mapping.account_id)
		.run();
}

/** 根据 Telegram 消息查找对应的邮件消息 */
export async function getMessageMapping(db: D1Database, chatId: string, tgMessageId: number): Promise<MessageMapping | null> {
	return db
		.prepare('SELECT * FROM message_map WHERE tg_chat_id = ? AND tg_message_id = ?')
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
	const placeholders = emailMessageIds.map(() => '?').join(',');
	const { results } = await db
		.prepare(`SELECT * FROM message_map WHERE account_id = ? AND email_message_id IN (${placeholders})`)
		.bind(accountId, ...emailMessageIds)
		.all<MessageMapping>();
	return results;
}

/** 更新星标状态 */
export async function updateStarred(db: D1Database, chatId: string, tgMessageId: number, starred: boolean): Promise<void> {
	await db
		.prepare('UPDATE message_map SET starred = ? WHERE tg_chat_id = ? AND tg_message_id = ?')
		.bind(starred ? 1 : 0, chatId, tgMessageId)
		.run();
}
