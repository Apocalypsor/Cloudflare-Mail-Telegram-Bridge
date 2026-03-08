import { processMessageNotification, processSyncNotification } from '../services/bridge';
import { reportErrorToObservability } from '../services/observability';
import type { Env, QueueMessage } from '../types';

/** Queue consumer: 处理邮件，内置重试 */
export async function handleQueueBatch(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
	for (const msg of batch.messages) {
		try {
			if (msg.body.type === 'sync') {
				await processSyncNotification(msg.body, env, ctx.waitUntil.bind(ctx));
			} else {
				await processMessageNotification(msg.body, env, ctx.waitUntil.bind(ctx));
			}
			msg.ack();
		} catch (error: unknown) {
			await reportErrorToObservability(env, 'queue.message_failed', error, {
				attempt: msg.attempts,
				type: msg.body.type,
				accountId: msg.body.accountId,
				messageId: msg.body.type === 'message' ? msg.body.messageId : undefined,
				pubsubMessageId: msg.body.type === 'sync' ? msg.body.pubsubMessageId : undefined,
			});
			msg.retry();
		}
	}
}
