import type { Env } from '@/types';

async function callBridge(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
	if (!env.IMAP_BRIDGE_URL || !env.IMAP_BRIDGE_SECRET) {
		throw new Error('IMAP bridge not configured (missing IMAP_BRIDGE_URL or IMAP_BRIDGE_SECRET)');
	}

	const url = `${env.IMAP_BRIDGE_URL.replace(/\/$/, '')}${path}`;
	const resp = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${env.IMAP_BRIDGE_SECRET}`,
			...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`IMAP bridge ${method} ${path} failed (${resp.status}): ${text}`);
	}

	return resp;
}

/** 通知中间件重新拉取账号列表（账号增删后调用） */
export async function syncAccounts(env: Env): Promise<void> {
	await callBridge(env, 'POST', '/api/sync');
}

/** 在 IMAP 中设置/取消邮件标志 */
export async function setImapFlag(
	env: Env,
	accountId: number,
	messageId: string,
	flag: '\\Seen' | '\\Flagged',
	add: boolean,
): Promise<void> {
	await callBridge(env, 'POST', '/api/flag', { accountId, messageId, flag, add });
}

/**
 * 列出未读邮件（需中间件实现 POST /api/unread → { messages: { id, subject? }[] }）。
 * 中间件内部执行 IMAP SEARCH UNSEEN + FETCH ENVELOPE。
 */
export async function listImapUnread(env: Env, accountId: number, maxResults: number = 20): Promise<{ id: string; subject?: string }[]> {
	const resp = await callBridge(env, 'POST', '/api/unread', { accountId, maxResults });
	const { messages } = await resp.json<{ messages: { id: string; subject?: string }[] }>();
	return messages ?? [];
}

/**
 * 列出星标邮件（需中间件实现 POST /api/starred → { messages: { id, subject? }[] }）。
 */
export async function listImapStarred(env: Env, accountId: number, maxResults: number = 20): Promise<{ id: string; subject?: string }[]> {
	const resp = await callBridge(env, 'POST', '/api/starred', { accountId, maxResults });
	const { messages } = await resp.json<{ messages: { id: string; subject?: string }[] }>();
	return messages ?? [];
}

/**
 * 从中间件按需拉取单封邮件原文（用于 LLM 重试），返回 base64 编码的 RFC 2822 raw email。
 * 中间件需实现 POST /api/fetch → { rawEmail: string }。
 */
export async function fetchImapRawEmail(env: Env, accountId: number, messageId: string): Promise<string> {
	const resp = await callBridge(env, 'POST', '/api/fetch', { accountId, messageId });
	const { rawEmail } = await resp.json<{ rawEmail: string }>();
	return rawEmail;
}

/**
 * 检查 IMAP 中间件健康状态。
 * /api/health 不需要鉴权，503 或 ok=false 表示不健康。
 * 返回 null 表示未配置 IMAP bridge（跳过检查）。
 */
export async function checkImapBridgeHealth(env: Env): Promise<{ ok: boolean; total: number; usable: number } | null> {
	if (!env.IMAP_BRIDGE_URL) return null;
	const url = `${env.IMAP_BRIDGE_URL.replace(/\/$/, '')}/api/health`;
	const resp = await fetch(url);
	const body = await resp.json<{ ok: boolean; total: number; usable: number }>();
	return body;
}
