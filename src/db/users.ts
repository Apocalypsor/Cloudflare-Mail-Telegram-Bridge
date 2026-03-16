import type { TelegramUser } from '@/types';

/** 登录时 upsert 用户信息（approved 仅在首次 INSERT 时设置，UPDATE 不覆盖） */
export async function upsertUser(
	db: D1Database,
	telegramId: string,
	firstName: string,
	lastName?: string,
	username?: string,
	photoUrl?: string,
	approved?: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO users (telegram_id, first_name, last_name, username, photo_url, approved, last_login_at)
			 VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
			 ON CONFLICT (telegram_id) DO UPDATE SET
			   first_name = excluded.first_name,
			   last_name = excluded.last_name,
			   username = excluded.username,
			   photo_url = excluded.photo_url,
			   last_login_at = datetime('now')`,
		)
		.bind(telegramId, firstName, lastName ?? null, username ?? null, photoUrl ?? null, approved ?? 0)
		.run();
}

/** 根据 Telegram ID 查询用户 */
export async function getUserByTelegramId(db: D1Database, telegramId: string): Promise<TelegramUser | null> {
	return db.prepare('SELECT * FROM users WHERE telegram_id = ?').bind(telegramId).first<TelegramUser>();
}

/** 获取所有已登录过的用户 */
export async function getAllUsers(db: D1Database): Promise<TelegramUser[]> {
	const { results } = await db.prepare('SELECT * FROM users ORDER BY last_login_at DESC').all<TelegramUser>();
	return results;
}

/** 获取除管理员外的所有用户 */
export async function getNonAdminUsers(db: D1Database, adminTelegramId: string): Promise<TelegramUser[]> {
	const { results } = await db
		.prepare('SELECT * FROM users WHERE telegram_id != ? ORDER BY last_login_at DESC')
		.bind(adminTelegramId)
		.all<TelegramUser>();
	return results;
}

/** 批准用户 */
export async function approveUser(db: D1Database, telegramId: string): Promise<void> {
	await db.prepare('UPDATE users SET approved = 1 WHERE telegram_id = ?').bind(telegramId).run();
}

/** 拒绝用户（重置为未批准） */
export async function rejectUser(db: D1Database, telegramId: string): Promise<void> {
	await db.prepare('UPDATE users SET approved = 0 WHERE telegram_id = ?').bind(telegramId).run();
}

/** 删除用户（同时解除其关联的账号绑定） */
export async function deleteUser(db: D1Database, telegramId: string): Promise<void> {
	await db.batch([
		db.prepare('UPDATE accounts SET telegram_user_id = NULL WHERE telegram_user_id = ?').bind(telegramId),
		db.prepare('DELETE FROM users WHERE telegram_id = ?').bind(telegramId),
	]);
}
