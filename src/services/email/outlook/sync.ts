import type { Env } from '../../../types';
import { getAccountById } from '../../../db/accounts';

/** Microsoft Graph change notification payload */
export interface GraphNotification {
	value: Array<{
		subscriptionId: string;
		changeType: string;
		resource: string;
		resourceData?: {
			id: string;
			'@odata.type': string;
			'@odata.id': string;
			'@odata.etag'?: string;
		};
		clientState?: string;
	}>;
}

/**
 * 解析 Graph change notification，获取新邮件 ID 并入队。
 * resource 格式: "Users('...')/Messages('AAMk...')" 或
 *                "me/mailFolders('Inbox')/messages('AAMk...')"
 */
export async function enqueueOutlookNotification(body: GraphNotification, env: Env): Promise<void> {
	const batch: Array<{ body: { accountId: number; messageId: string } }> = [];

	for (const notification of body.value) {
		// 验证 clientState
		if (notification.clientState !== env.MS_WEBHOOK_SECRET) {
			console.log('Outlook push: invalid clientState, skipping');
			continue;
		}

		const messageId = notification.resourceData?.id;
		if (!messageId) {
			console.log('Outlook push: no resourceData.id, skipping');
			continue;
		}

		// 从 KV 中根据 subscriptionId 找到 accountId
		// 我们在 KV 中存的是 ms_subscription:{accountId} -> subscriptionId
		// 需要反向查找，所以我们也存一个反向映射
		const accountIdStr = await env.EMAIL_KV.get(`ms_sub_account:${notification.subscriptionId}`);
		if (!accountIdStr) {
			console.log(`Outlook push: unknown subscriptionId ${notification.subscriptionId}`);
			continue;
		}

		const accountId = parseInt(accountIdStr, 10);
		const account = await getAccountById(env.DB, accountId);
		if (!account) {
			console.log(`Outlook push: account ${accountId} not found`);
			continue;
		}

		batch.push({ body: { accountId: account.id, messageId } });
	}

	if (batch.length > 0) {
		console.log(`Outlook push: enqueueing ${batch.length} messages`);
		await env.EMAIL_QUEUE.sendBatch(batch);
	}
}
