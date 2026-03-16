import { GMAIL_API, GOOGLE_OAUTH_TOKEN_URL } from '@/constants';
import type { Account, Env } from '@/types';
import { AccountType } from '@/types';
import { getAllAccounts } from '@db/accounts';
import { getCachedAccessToken, getHistoryId, putCachedAccessToken, putHistoryId } from '@db/kv';
import type { GoogleTokenResponse } from '@services/email/gmail/oauth';

// ─── OAuth2 ──────────────────────────────────────────────────────────────────

/** 用 refresh_token 换 access_token，带 KV 缓存（按账号隔离） */
export async function getAccessToken(env: Env, account: Account): Promise<string> {
	const cached = await getCachedAccessToken(env, account.id);
	if (cached) return cached;

	if (!account.refresh_token) {
		throw new Error(`Account ${account.email} has no refresh token. Authorize via OAuth first.`);
	}

	const resp = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env.GMAIL_CLIENT_ID,
			client_secret: env.GMAIL_CLIENT_SECRET,
			refresh_token: account.refresh_token,
			grant_type: 'refresh_token',
		}),
	});

	if (!resp.ok) {
		throw new Error(`Token exchange failed for ${account.email}: ${await resp.text()}`);
	}

	const data = (await resp.json()) as GoogleTokenResponse;
	if (!data.access_token || !data.expires_in) {
		throw new Error('Token response missing access_token or expires_in');
	}
	// 缓存到 KV，TTL 比实际过期提前 120 秒
	await putCachedAccessToken(env, account.id, data.access_token, Math.max(data.expires_in - 120, 60));

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
	const text = await resp.text();
	return text ? JSON.parse(text) : null;
}

// ─── Message actions ─────────────────────────────────────────────────────────

/** 将邮件标记为已读（移除 UNREAD 标签） */
export async function markAsRead(token: string, messageId: string): Promise<void> {
	await gmailPost(token, `/users/me/messages/${messageId}/modify`, {
		removeLabelIds: ['UNREAD'],
	});
}

/** 给邮件加星标（添加 STARRED 标签） */
export async function addStar(token: string, messageId: string): Promise<void> {
	await gmailPost(token, `/users/me/messages/${messageId}/modify`, {
		addLabelIds: ['STARRED'],
	});
}

/** 移除邮件星标 */
export async function removeStar(token: string, messageId: string): Promise<void> {
	await gmailPost(token, `/users/me/messages/${messageId}/modify`, {
		removeLabelIds: ['STARRED'],
	});
}

/** 检查邮件是否已星标 */
export async function isStarred(token: string, messageId: string): Promise<boolean> {
	const msg = await gmailGet(token, `/users/me/messages/${messageId}?format=MINIMAL`);
	return (msg.labelIds as string[] | undefined)?.includes('STARRED') ?? false;
}

/** 列出未读邮件（最多 maxResults 条），含标题 */
export async function listUnreadMessages(token: string, maxResults: number = 20): Promise<{ id: string; subject?: string }[]> {
	const data = await gmailGet(token, `/users/me/messages?q=is:unread&maxResults=${maxResults}`);
	if (!data.messages) return [];
	const ids = (data.messages as { id: string }[]).map((m) => m.id);
	const details = await Promise.all(
		ids.map(async (id) => {
			try {
				const msg = await gmailGet(token, `/users/me/messages/${id}?format=METADATA&metadataHeaders=Subject`);
				const subjectHeader = (msg.payload?.headers as { name: string; value: string }[])?.find(
					(h: { name: string }) => h.name.toLowerCase() === 'subject',
				);
				return { id, subject: subjectHeader?.value };
			} catch {
				return { id };
			}
		}),
	);
	return details;
}

/** 列出星标邮件（最多 maxResults 条），含标题 */
export async function listStarredMessages(token: string, maxResults: number = 20): Promise<{ id: string; subject?: string }[]> {
	const data = await gmailGet(token, `/users/me/messages?q=is:starred&maxResults=${maxResults}`);
	if (!data.messages) return [];
	const ids = (data.messages as { id: string }[]).map((m) => m.id);
	const details = await Promise.all(
		ids.map(async (id) => {
			try {
				const msg = await gmailGet(token, `/users/me/messages/${id}?format=METADATA&metadataHeaders=Subject`);
				const subjectHeader = (msg.payload?.headers as { name: string; value: string }[])?.find(
					(h: { name: string }) => h.name.toLowerCase() === 'subject',
				);
				return { id, subject: subjectHeader?.value };
			} catch {
				return { id };
			}
		}),
	);
	return details;
}

// ─── Watch ───────────────────────────────────────────────────────────────────

/** 停止单个账号的 Gmail push 通知 (watch) */
export async function stopWatch(env: Env, account: Account): Promise<void> {
	const token = await getAccessToken(env, account);
	await gmailPost(token, '/users/me/stop', {});
	console.log(`Gmail watch stopped for ${account.email}`);
}

/** 为单个账号注册 / 续订 Gmail push 通知 (watch) */
export async function renewWatch(env: Env, account: Account): Promise<void> {
	const token = await getAccessToken(env, account);
	const result = await gmailPost(token, '/users/me/watch', {
		topicName: env.GMAIL_PUBSUB_TOPIC,
		labelIds: ['INBOX'],
	});
	if (!result?.historyId) {
		throw new Error(`Gmail watch returned no historyId for ${account.email}`);
	}
	console.log(`Gmail watch renewed for ${account.email}, historyId:`, result.historyId, 'expiration:', result.expiration);

	// 如果 KV 里还没有 historyId，用 watch 返回的初始化
	const existing = await getHistoryId(env, account.id);
	if (!existing) {
		await putHistoryId(env, account.id, String(result.historyId));
	}
}

/** 为所有已授权的 Gmail 账号续订 watch */
export async function renewWatchAll(env: Env): Promise<void> {
	const accounts = await getAllAccounts(env.DB);
	for (const account of accounts) {
		if (account.type !== AccountType.Gmail || !account.refresh_token) {
			console.log(`Skipping watch renewal for ${account.email}: not a Gmail account or no refresh token`);
			continue;
		}
		await renewWatch(env, account);
	}
}

// ─── History / 新邮件拉取 ────────────────────────────────────────────────────

/** 拉取自上次 historyId 以来的新 INBOX 消息 ID 列表 */
export async function fetchNewMessageIds(token: string, env: Env, account: Account): Promise<string[]> {
	const storedHistoryId = await getHistoryId(env, account.id);
	if (!storedHistoryId) return [];

	const messageIds = new Set<string>();
	let pageToken: string | undefined;
	let latestHistoryId: string | undefined;

	do {
		let path = `/users/me/history?startHistoryId=${storedHistoryId}&historyTypes=messageAdded&labelId=INBOX`;
		if (pageToken) path += `&pageToken=${pageToken}`;

		let history: Record<string, any>;
		try {
			history = await gmailGet(token, path);
		} catch (err) {
			if (err instanceof Error && (err as any).status === 404) {
				// historyId 过老，重新同步
				console.warn(`historyId expired for ${account.email}, resetting`);
				const profile = await gmailGet(token, '/users/me/profile');
				await putHistoryId(env, account.id, String(profile.historyId));
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
		if (history.historyId) {
			latestHistoryId = String(history.historyId);
		}
	} while (pageToken);

	// 分页结束后一次性更新 historyId
	if (latestHistoryId) {
		await putHistoryId(env, account.id, latestHistoryId);
	}

	return [...messageIds];
}
