import type { Account } from '../types';

export async function getAllAccounts(db: D1Database): Promise<Account[]> {
	const { results } = await db.prepare('SELECT * FROM accounts ORDER BY id').all<Account>();
	return results;
}

export async function getAccountById(db: D1Database, id: number): Promise<Account | null> {
	return db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<Account>();
}

export async function getAccountByEmail(db: D1Database, email: string): Promise<Account | null> {
	return db.prepare('SELECT * FROM accounts WHERE email = ?').bind(email).first<Account>();
}

export async function createAccount(db: D1Database, chatId: string, label?: string): Promise<Account> {
	const result = await db
		.prepare('INSERT INTO accounts (chat_id, label) VALUES (?, ?) RETURNING *')
		.bind(chatId, label ?? null)
		.first<Account>();
	if (!result) throw new Error('Failed to create account');
	return result;
}

export async function deleteAccount(db: D1Database, id: number): Promise<void> {
	await db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
}

export async function updateRefreshToken(db: D1Database, id: number, refreshToken: string): Promise<void> {
	await db.prepare("UPDATE accounts SET refresh_token = ?, updated_at = datetime('now') WHERE id = ?").bind(refreshToken, id).run();
}

export async function updateAccountEmail(db: D1Database, id: number, email: string): Promise<void> {
	await db.prepare("UPDATE accounts SET email = ?, updated_at = datetime('now') WHERE id = ?").bind(email, id).run();
}

export async function updateAccount(db: D1Database, id: number, chatId: string, label: string | null): Promise<void> {
	await db.prepare("UPDATE accounts SET chat_id = ?, label = ?, updated_at = datetime('now') WHERE id = ?").bind(chatId, label, id).run();
}
