import type { Env } from './types';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const KV_HISTORY_ID = 'gmail_history_id';
const KV_ACCESS_TOKEN = 'gmail_access_token';

// ─── OAuth2 ──────────────────────────────────────────────────────────────────

/** 用 refresh_token 换 access_token，带 KV 缓存 */
export async function getAccessToken(env: Env): Promise<string> {
	const cached = await env.EMAIL_KV.get(KV_ACCESS_TOKEN);
	if (cached) return cached;

	const resp = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env.GMAIL_CLIENT_ID,
			client_secret: env.GMAIL_CLIENT_SECRET,
			refresh_token: env.GMAIL_REFRESH_TOKEN,
			grant_type: 'refresh_token',
		}),
	});

	if (!resp.ok) {
		throw new Error(`Token exchange failed: ${await resp.text()}`);
	}

	const data = (await resp.json()) as { access_token: string; expires_in: number };
	// 缓存到 KV，TTL 比实际过期提前 120 秒
	await env.EMAIL_KV.put(KV_ACCESS_TOKEN, data.access_token, {
		expirationTtl: Math.max(data.expires_in - 120, 60),
	});

	return data.access_token;
}

// ─── REST helpers ────────────────────────────────────────────────────────────

/** 调用 Gmail REST API (GET) */
export async function gmailGet(token: string, path: string): Promise<any> {
	const resp = await fetch(`${GMAIL_API}${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!resp.ok) {
		const text = await resp.text();
		throw Object.assign(new Error(`Gmail API ${resp.status}: ${text}`), { status: resp.status });
	}
	return resp.json();
}

/** 调用 Gmail REST API (POST with JSON body) */
export async function gmailPost(token: string, path: string, body: Record<string, unknown>): Promise<any> {
	const resp = await fetch(`${GMAIL_API}${path}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		const text = await resp.text();
		throw Object.assign(new Error(`Gmail API ${resp.status}: ${text}`), { status: resp.status });
	}
	return resp.json();
}

// ─── Watch ───────────────────────────────────────────────────────────────────

/** 注册 / 续订 Gmail push 通知 (watch) */
export async function renewWatch(env: Env): Promise<void> {
	const token = await getAccessToken(env);
	const result = await gmailPost(token, '/users/me/watch', {
		topicName: env.GMAIL_PUBSUB_TOPIC,
		labelIds: ['INBOX'],
	});
	console.log('Gmail watch renewed, historyId:', result.historyId, 'expiration:', result.expiration);

	// 如果 KV 里还没有 historyId，用 watch 返回的初始化
	const existing = await env.EMAIL_KV.get(KV_HISTORY_ID);
	if (!existing) {
		await env.EMAIL_KV.put(KV_HISTORY_ID, String(result.historyId));
	}
}

// ─── History / 新邮件拉取 ────────────────────────────────────────────────────

/** 拉取自 storedHistoryId 以来的新 INBOX 消息 ID 列表 */
export async function fetchNewMessageIds(token: string, env: Env, storedHistoryId: string): Promise<string[]> {
	const messageIds = new Set<string>();
	let pageToken: string | undefined;

	do {
		let path = `/users/me/history?startHistoryId=${storedHistoryId}&historyTypes=messageAdded&labelId=INBOX`;
		if (pageToken) path += `&pageToken=${pageToken}`;

		let history: any;
		try {
			history = await gmailGet(token, path);
		} catch (err: any) {
			if (err.status === 404) {
				// historyId 过老，重新同步
				console.warn('historyId 过期，重新同步');
				const profile = await gmailGet(token, '/users/me/profile');
				await env.EMAIL_KV.put(KV_HISTORY_ID, String(profile.historyId));
				return [];
			}
			throw err;
		}

		if (history.history) {
			for (const h of history.history) {
				if (h.messagesAdded) {
					for (const added of h.messagesAdded) {
						if (added.message?.labelIds?.includes('INBOX')) {
							messageIds.add(added.message.id);
						}
					}
				}
			}
		}

		pageToken = history.nextPageToken;
		// 更新为最新 historyId
		if (history.historyId) {
			await env.EMAIL_KV.put(KV_HISTORY_ID, String(history.historyId));
		}
	} while (pageToken);

	return [...messageIds];
}

/** base64url → ArrayBuffer */
export function base64urlToArrayBuffer(b64url: string): ArrayBuffer {
	let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
	while (b64.length % 4) b64 += '=';

	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		bytes[i] = bin.charCodeAt(i);
	}
	return bytes.buffer;
}

export { KV_HISTORY_ID };
