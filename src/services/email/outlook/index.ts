import {
	KV_MS_SUB_ACCOUNT_PREFIX,
	KV_MS_SUBSCRIPTION_PREFIX,
	MS_GRAPH_API,
	MS_MAIL_SCOPE,
	MS_OAUTH_TOKEN_URL,
	MS_SUBSCRIPTION_LIFETIME_MINUTES,
} from '@/constants';
import { getAllAccounts } from '@db/accounts';
import { getCachedAccessToken, putCachedAccessToken } from '@db/kv';
import { AccountType, type Account, type Env } from '@/types';
import type { MsTokenResponse } from '@services/email/outlook/oauth';
import { HTTPError } from 'ky';
import { http } from '@utils/http';

// ─── OAuth2 ──────────────────────────────────────────────────────────────────

/** 用 refresh_token 换 access_token，带 KV 缓存 */
export async function getAccessToken(env: Env, account: Account): Promise<string> {
	const cached = await getCachedAccessToken(env, account.id);
	if (cached) return cached;

	if (!account.refresh_token) {
		throw new Error(`Account ${account.email} has no refresh token. Authorize via OAuth first.`);
	}

	let data: MsTokenResponse;
	try {
		data = (await http
			.post(MS_OAUTH_TOKEN_URL, {
				body: new URLSearchParams({
					client_id: env.MS_CLIENT_ID!,
					client_secret: env.MS_CLIENT_SECRET!,
					refresh_token: account.refresh_token,
					grant_type: 'refresh_token',
					scope: MS_MAIL_SCOPE,
				}),
			})
			.json()) as MsTokenResponse;
	} catch (err) {
		if (err instanceof HTTPError) {
			throw new Error(`MS token exchange failed for ${account.email}: ${await err.response.text()}`);
		}
		throw err;
	}
	if (!data.access_token || !data.expires_in) {
		throw new Error('MS token response missing access_token or expires_in');
	}
	await putCachedAccessToken(env, account.id, data.access_token, Math.max(data.expires_in - 120, 60));

	return data.access_token;
}

// ─── REST helpers ────────────────────────────────────────────────────────────

/** 调用 Graph API (GET) */
export async function graphGet(token: string, path: string): Promise<any> {
	return http
		.get(`${MS_GRAPH_API}${path}`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		.json();
}

/** 调用 Graph API (PATCH with JSON body) */
export async function graphPatch(token: string, path: string, body: Record<string, unknown>): Promise<void> {
	await http.patch(`${MS_GRAPH_API}${path}`, {
		headers: { Authorization: `Bearer ${token}` },
		json: body,
	});
}

/** 调用 Graph API (POST with JSON body) */
export async function graphPost(token: string, path: string, body: Record<string, unknown>): Promise<any> {
	const resp = await http.post(`${MS_GRAPH_API}${path}`, {
		headers: { Authorization: `Bearer ${token}` },
		json: body,
	});
	const text = await resp.text();
	return text ? JSON.parse(text) : null;
}

/** 调用 Graph API (DELETE) */
export async function graphDelete(token: string, path: string): Promise<void> {
	await http.delete(`${MS_GRAPH_API}${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
}

/** 获取邮件的原始 MIME 内容 */
export async function fetchRawMime(token: string, messageId: string): Promise<ArrayBuffer> {
	return http
		.get(`${MS_GRAPH_API}/me/messages/${messageId}/$value`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		.arrayBuffer();
}

// ─── Message actions ─────────────────────────────────────────────────────────

/** 将邮件标记为已读 */
export async function markAsRead(token: string, messageId: string): Promise<void> {
	await graphPatch(token, `/me/messages/${messageId}`, { isRead: true });
}

/** 给邮件加星标（flag） */
export async function addStar(token: string, messageId: string): Promise<void> {
	await graphPatch(token, `/me/messages/${messageId}`, { flag: { flagStatus: 'flagged' } });
}

/** 移除邮件星标 */
export async function removeStar(token: string, messageId: string): Promise<void> {
	await graphPatch(token, `/me/messages/${messageId}`, { flag: { flagStatus: 'notFlagged' } });
}

/** 检查邮件是否已星标 */
export async function isStarred(token: string, messageId: string): Promise<boolean> {
	const msg = await graphGet(token, `/me/messages/${messageId}?$select=flag`);
	return msg.flag?.flagStatus === 'flagged';
}

/** 列出未读邮件（最多 top 条），含标题 */
export async function listUnreadMessages(token: string, top: number = 20): Promise<{ id: string; subject?: string }[]> {
	const data = await graphGet(token, `/me/mailFolders('Inbox')/messages?$filter=isRead eq false&$select=id,subject&$top=${top}`);
	if (!data.value) return [];
	return (data.value as { id: string; subject?: string }[]).map((m) => ({ id: m.id, subject: m.subject }));
}

/** 列出星标邮件（最多 top 条），含标题 */
export async function listStarredMessages(token: string, top: number = 20): Promise<{ id: string; subject?: string }[]> {
	const data = await graphGet(token, `/me/messages?$filter=flag/flagStatus eq 'flagged'&$select=id,subject&$top=${top}`);
	if (!data.value) return [];
	return (data.value as { id: string; subject?: string }[]).map((m) => ({ id: m.id, subject: m.subject }));
}

/** 列出垃圾邮件（最多 top 条），含标题 */
export async function listJunkMessages(token: string, top: number = 20): Promise<{ id: string; subject?: string }[]> {
	const data = await graphGet(token, `/me/mailFolders('JunkEmail')/messages?$select=id,subject&$top=${top}`);
	if (!data.value) return [];
	return (data.value as { id: string; subject?: string }[]).map((m) => ({ id: m.id, subject: m.subject }));
}

/** 将邮件标记为垃圾邮件（移到 JunkEmail 文件夹） */
export async function markAsJunk(token: string, messageId: string): Promise<void> {
	await graphPost(token, `/me/messages/${messageId}/move`, { destinationId: 'JunkEmail' });
}

/** 将垃圾邮件移回收件箱 */
export async function moveToInbox(token: string, messageId: string): Promise<void> {
	await graphPost(token, `/me/messages/${messageId}/move`, { destinationId: 'Inbox' });
}

/** 删除邮件 */
export async function deleteMessage(token: string, messageId: string): Promise<void> {
	await graphDelete(token, `/me/messages/${messageId}`);
}

/** 清空所有垃圾邮件 */
export async function deleteAllJunk(token: string): Promise<number> {
	const data = await graphGet(token, `/me/mailFolders('JunkEmail')/messages?$select=id&$top=100`);
	if (!data.value || data.value.length === 0) return 0;
	const ids = (data.value as { id: string }[]).map((m) => m.id);
	await Promise.all(ids.map((id) => graphDelete(token, `/me/messages/${id}`)));
	return ids.length;
}

// ─── Subscription (webhook) ──────────────────────────────────────────────────

/** 为单个账号创建/续订 Graph change notification subscription */
export async function renewSubscription(env: Env, account: Account): Promise<void> {
	if (!env.MS_WEBHOOK_SECRET) {
		throw new Error('MS_WEBHOOK_SECRET not configured');
	}
	const token = await getAccessToken(env, account);
	const workerUrl = env.WORKER_URL?.replace(/\/$/, '') || '';
	const notificationUrl = `${workerUrl}/api/outlook/push?secret=${env.MS_WEBHOOK_SECRET}`;

	const expiration = new Date(Date.now() + MS_SUBSCRIPTION_LIFETIME_MINUTES * 60 * 1000).toISOString();

	// 先尝试查找已有 subscription
	const existingKey = `${KV_MS_SUBSCRIPTION_PREFIX}${account.id}`;
	const existingSubId = await env.EMAIL_KV.get(existingKey);

	if (existingSubId) {
		// 尝试续订
		try {
			const resp = await http.patch(`${MS_GRAPH_API}/subscriptions/${existingSubId}`, {
				headers: { Authorization: `Bearer ${token}` },
				json: { expirationDateTime: expiration },
				throwHttpErrors: false,
			});
			if (resp.ok) {
				// 续订成功，刷新反向映射 TTL
				await env.EMAIL_KV.put(`${KV_MS_SUB_ACCOUNT_PREFIX}${existingSubId}`, String(account.id), {
					expirationTtl: MS_SUBSCRIPTION_LIFETIME_MINUTES * 60,
				});
				console.log(`Outlook subscription renewed for ${account.email}`);
				return;
			}
			// 续订失败，创建新的
		} catch {
			// 续订失败，创建新的
		}
	}

	// 创建新 subscription
	let sub: { id: string };
	try {
		sub = (await http
			.post(`${MS_GRAPH_API}/subscriptions`, {
				headers: { Authorization: `Bearer ${token}` },
				json: {
					changeType: 'created',
					notificationUrl,
					resource: "me/mailFolders('Inbox')/messages",
					expirationDateTime: expiration,
					clientState: env.MS_WEBHOOK_SECRET,
				},
			})
			.json()) as { id: string };
	} catch (err) {
		if (err instanceof HTTPError) {
			const text = await err.response.text();
			throw new Error(`Failed to create Graph subscription for ${account.email}: ${err.response.status} ${text}`);
		}
		throw err;
	}
	const ttl = MS_SUBSCRIPTION_LIFETIME_MINUTES * 60;
	await Promise.all([
		env.EMAIL_KV.put(existingKey, sub.id, { expirationTtl: ttl }),
		env.EMAIL_KV.put(`${KV_MS_SUB_ACCOUNT_PREFIX}${sub.id}`, String(account.id), { expirationTtl: ttl }),
	]);
	console.log(`Outlook subscription created for ${account.email}, id=${sub.id}`);
}

/** 停止 subscription */
export async function stopSubscription(env: Env, account: Account): Promise<void> {
	const token = await getAccessToken(env, account);
	const existingKey = `${KV_MS_SUBSCRIPTION_PREFIX}${account.id}`;
	const subId = await env.EMAIL_KV.get(existingKey);
	if (!subId) return;

	try {
		await http.delete(`${MS_GRAPH_API}/subscriptions/${subId}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
	} catch {
		// 删除失败不影响主流程
	}
	await env.EMAIL_KV.delete(existingKey);
	console.log(`Outlook subscription stopped for ${account.email}`);
}

/** 为所有已授权的 Outlook 账号续订 subscription */
export async function renewSubscriptionAll(env: Env): Promise<void> {
	const accounts = await getAllAccounts(env.DB);
	for (const account of accounts) {
		if (account.type !== AccountType.Outlook || !account.refresh_token) continue;
		await renewSubscription(env, account);
	}
}
