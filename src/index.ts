import app from './handlers/hono';
import { handleQueueBatch } from './handlers/queue';
import { renewWatchAll } from './services/email/gmail';
import { reportErrorToObservability } from './services/observability';
import type { Env, QueueMessage } from './types';

export type { Env } from './types';

export default {
	fetch: app.fetch,

	async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
		await handleQueueBatch(batch, env, ctx);
	},

	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(handleScheduledRenewWatch(env));
	},
};

async function handleScheduledRenewWatch(env: Env): Promise<void> {
	try {
		await renewWatchAll(env);
	} catch (error: unknown) {
		await reportErrorToObservability(env, 'scheduled.watch_renew_failed', error, {
			schedule: '0 0 */6 * *',
		});
	}
}
