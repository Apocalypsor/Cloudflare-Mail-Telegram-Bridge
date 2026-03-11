import { getAccountByEmail } from '../../../db/accounts';
import { getHistoryId, putHistoryId } from '../../../db/kv';
import type { Env, GmailNotification, PubSubPushBody } from '../../../types';
import { fetchNewMessageIds, getAccessToken } from './index';

/** 解析 Pub/Sub 通知，获取新邮件列表并直接入队 */
export async function enqueueSyncNotification(body: PubSubPushBody, env: Env): Promise<void> {
	const decoded: GmailNotification = JSON.parse(atob(body.message.data));
	console.log(`Pub/Sub notification: email=${decoded.emailAddress}, historyId=${decoded.historyId}`);

	const account = await getAccountByEmail(env.DB, decoded.emailAddress);
	if (!account) {
		console.log(`No account found for ${decoded.emailAddress}, skipping`);
		return;
	}

	const storedHistoryId = await getHistoryId(env, account.id);
	if (!storedHistoryId) {
		await putHistoryId(env, account.id, decoded.historyId);
		console.log(`Initialized historyId for ${account.email}:`, decoded.historyId);
		return;
	}

	const token = await getAccessToken(env, account);
	const messageIds = await fetchNewMessageIds(token, env, account);
	if (messageIds.length === 0) {
		console.log(`No new messages for ${account.email}`);
		return;
	}

	console.log(`Found ${messageIds.length} new messages for ${account.email}, enqueueing`);
	await env.EMAIL_QUEUE.sendBatch(
		messageIds.map((id) => ({
			body: { accountId: account.id, messageId: id },
		})),
	);
}
