import type { Env } from '@/types';
import { HTTPError } from 'ky';
import { http } from '@utils/http';

async function callBridge(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
	if (!env.IMAP_BRIDGE_URL || !env.IMAP_BRIDGE_SECRET) {
		throw new Error('IMAP bridge not configured (missing IMAP_BRIDGE_URL or IMAP_BRIDGE_SECRET)');
	}

	const url = `${env.IMAP_BRIDGE_URL.replace(/\/$/, '')}${path}`;
	try {
		return await http(url, {
			method,
			headers: { Authorization: `Bearer ${env.IMAP_BRIDGE_SECRET}` },
			...(body !== undefined && { json: body }),
		});
	} catch (err) {
		if (err instanceof HTTPError) {
			const text = await err.response.text();
			throw new Error(`IMAP bridge ${method} ${path} failed (${err.response.status}): ${text}`);
		}
		throw err;
	}
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
	const { messages } = (await resp.json()) as { messages: { id: string; subject?: string }[] };
	return messages ?? [];
}

/**
 * 列出星标邮件（需中间件实现 POST /api/starred → { messages: { id, subject? }[] }）。
 */
export async function listImapStarred(env: Env, accountId: number, maxResults: number = 20): Promise<{ id: string; subject?: string }[]> {
	const resp = await callBridge(env, 'POST', '/api/starred', { accountId, maxResults });
	const { messages } = (await resp.json()) as { messages: { id: string; subject?: string }[] };
	return messages ?? [];
}

/**
 * 列出垃圾邮件（需中间件实现 POST /api/junk → { messages: { id, subject? }[] }）。
 */
export async function listImapJunk(env: Env, accountId: number, maxResults: number = 20): Promise<{ id: string; subject?: string }[]> {
	const resp = await callBridge(env, 'POST', '/api/junk', { accountId, maxResults });
	const { messages } = (await resp.json()) as { messages: { id: string; subject?: string }[] };
	return messages ?? [];
}

/** 检查邮件是否在垃圾邮件文件夹 */
export async function isImapJunk(env: Env, accountId: number, messageId: string): Promise<boolean> {
	const resp = await callBridge(env, 'POST', '/api/is-junk', { accountId, messageId });
	const { junk } = (await resp.json()) as { junk: boolean };
	return junk;
}

/** 将邮件标记为垃圾邮件（移到 Junk 文件夹） */
export async function imapMarkAsJunk(env: Env, accountId: number, messageId: string): Promise<void> {
	await callBridge(env, 'POST', '/api/mark-as-junk', { accountId, messageId });
}

/** 将垃圾邮件移回收件箱 */
export async function imapMoveToInbox(env: Env, accountId: number, messageId: string): Promise<void> {
	await callBridge(env, 'POST', '/api/move-to-inbox', { accountId, messageId });
}

/** 移到回收站 */
export async function imapTrashMessage(env: Env, accountId: number, messageId: string): Promise<void> {
	await callBridge(env, 'POST', '/api/trash', { accountId, messageId });
}

/** 清空所有垃圾邮件（移到回收站） */
export async function imapTrashAllJunk(env: Env, accountId: number): Promise<number> {
	const resp = await callBridge(env, 'POST', '/api/trash-all-junk', { accountId });
	const { count } = (await resp.json()) as { count: number };
	return count;
}

/** 检查邮件是否已星标（\Flagged） */
export async function isImapStarred(env: Env, accountId: number, messageId: string): Promise<boolean> {
	const resp = await callBridge(env, 'POST', '/api/is-starred', { accountId, messageId });
	const { starred } = (await resp.json()) as { starred: boolean };
	return starred;
}

/**
 * 从中间件按需拉取单封邮件原文（用于 LLM 重试），返回 base64 编码的 RFC 2822 raw email。
 * 中间件需实现 POST /api/fetch → { rawEmail: string }。
 */
export async function fetchImapRawEmail(env: Env, accountId: number, messageId: string): Promise<string> {
	const resp = await callBridge(env, 'POST', '/api/fetch', { accountId, messageId });
	const { rawEmail } = (await resp.json()) as { rawEmail: string };
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
	const resp = await http.get(url, { throwHttpErrors: false });
	return (await resp.json()) as { ok: boolean; total: number; usable: number };
}
