/** message_map: Telegram 消息 ↔ Gmail 消息映射 */

export interface MessageMapping {
	tg_message_id: number;
	tg_chat_id: string;
	gmail_message_id: string;
	account_id: number;
	starred: number; // 0 = 未星标, 1 = 已星标
}

/** 保存 Telegram → Gmail 消息映射 */
export async function putMessageMapping(db: D1Database, mapping: Omit<MessageMapping, 'starred'>): Promise<void> {
	await db
		.prepare('INSERT OR IGNORE INTO message_map (tg_message_id, tg_chat_id, gmail_message_id, account_id) VALUES (?, ?, ?, ?)')
		.bind(mapping.tg_message_id, mapping.tg_chat_id, mapping.gmail_message_id, mapping.account_id)
		.run();
}

/** 根据 Telegram 消息查找对应的 Gmail 消息 */
export async function getMessageMapping(db: D1Database, chatId: string, tgMessageId: number): Promise<MessageMapping | null> {
	return db
		.prepare('SELECT * FROM message_map WHERE tg_chat_id = ? AND tg_message_id = ?')
		.bind(chatId, tgMessageId)
		.first<MessageMapping>();
}

/** 根据 Gmail 消息 ID 查找映射（用于邮件原文查看） */
export async function getMessageMappingByGmailId(db: D1Database, gmailMessageId: string): Promise<MessageMapping | null> {
	return db
		.prepare('SELECT * FROM message_map WHERE gmail_message_id = ? LIMIT 1')
		.bind(gmailMessageId)
		.first<MessageMapping>();
}

/** 更新星标状态 */
export async function updateStarred(db: D1Database, chatId: string, tgMessageId: number, starred: boolean): Promise<void> {
	await db
		.prepare('UPDATE message_map SET starred = ? WHERE tg_chat_id = ? AND tg_message_id = ?')
		.bind(starred ? 1 : 0, chatId, tgMessageId)
		.run();
}
