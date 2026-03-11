import { processEmailMessage } from '../services/bridge';
import { reportErrorToObservability } from '../services/observability';
import type { Env, QueueMessage } from '../types';

/** Queue consumer: 处理邮件，内置重试 */
export async function handleQueueBatch(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
	for (const msg of batch.messages) {
		try {
			await processEmailMessage(msg.body, env, ctx.waitUntil.bind(ctx));
			msg.ack();
		} catch (error: unknown) {
			await reportErrorToObservability(env, 'queue.message_failed', error, {
				attempt: msg.attempts,
				accountId: msg.body.accountId,
				messageId: msg.body.messageId,
			});
			msg.retry();
		}
	}
}
