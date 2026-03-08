import type { Env } from '../types';

// ─── Key helpers ────────────────────────────────────────────────────────────

function kvAccessTokenKey(accountId: number): string {
	return `access_token:${accountId}`;
}

function kvHistoryIdKey(accountId: number): string {
	return `history_id:${accountId}`;
}

// ─── History ID ─────────────────────────────────────────────────────────────

export async function getHistoryId(env: Env, accountId: number): Promise<string | null> {
	return env.EMAIL_KV.get(kvHistoryIdKey(accountId));
}

export async function putHistoryId(env: Env, accountId: number, historyId: string): Promise<void> {
	await env.EMAIL_KV.put(kvHistoryIdKey(accountId), historyId);
}

export async function deleteHistoryId(env: Env, accountId: number): Promise<void> {
	await env.EMAIL_KV.delete(kvHistoryIdKey(accountId));
}

// ─── Access Token Cache ─────────────────────────────────────────────────────

export async function getCachedAccessToken(env: Env, accountId: number): Promise<string | null> {
	return env.EMAIL_KV.get(kvAccessTokenKey(accountId));
}

export async function putCachedAccessToken(env: Env, accountId: number, token: string, ttlSeconds: number): Promise<void> {
	await env.EMAIL_KV.put(kvAccessTokenKey(accountId), token, {
		expirationTtl: ttlSeconds,
	});
}

export async function deleteCachedAccessToken(env: Env, accountId: number): Promise<void> {
	await env.EMAIL_KV.delete(kvAccessTokenKey(accountId));
}

// ─── Clear Cache ────────────────────────────────────────────────────────────

/** 清除指定账号的 KV 缓存（history_id），access_token 有 TTL 自然过期 */
export async function clearAccountCache(env: Env, accountId: number): Promise<void> {
	await deleteHistoryId(env, accountId);
}

/** 清空 KV 中所有 key（全局），跳过 access_token（有 TTL 自然过期） */
export async function clearAllKV(env: Env): Promise<number> {
	let deleted = 0;
	let cursor: string | undefined;
	do {
		const list = await env.EMAIL_KV.list({ cursor, limit: 1000 });
		const toDelete = list.keys.filter((k) => !k.name.startsWith('access_token:'));
		if (toDelete.length > 0) {
			await Promise.all(toDelete.map((k) => env.EMAIL_KV.delete(k.name)));
			deleted += toDelete.length;
		}
		cursor = list.list_complete ? undefined : list.cursor;
	} while (cursor);
	return deleted;
}
