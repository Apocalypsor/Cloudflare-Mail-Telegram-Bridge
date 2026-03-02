import { processMessageNotification, processSyncNotification } from '../services/bridge';
import { reportErrorToObservability } from '../services/observability';
import type { Env, QueueMessage } from '../types';

/** Queue consumer: 串行处理邮件，内置重试 */
export async function handleQueueBatch(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
	for (const msg of batch.messages) {
		try {
			if (msg.body.type === 'sync') {
				await processSyncNotification(msg.body, env);
			} else {
				await processMessageNotification(msg.body.messageId, env);
			}
			msg.ack();
		} catch (error: unknown) {
			await reportErrorToObservability(env, 'queue.message_failed', error, {
				attempt: msg.attempts,
				type: msg.body.type,
				messageId: msg.body.type === 'message' ? msg.body.messageId : undefined,
				pubsubMessageId: msg.body.type === 'sync' ? msg.body.pubsubMessageId : undefined,
			});
			msg.retry();
		}
	}
}
