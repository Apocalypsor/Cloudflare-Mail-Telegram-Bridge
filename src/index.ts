import { handleHttpRequest } from './handlers/http';
import { handleQueueBatch } from './handlers/queue';
import { renewWatch } from './services/gmail';
import { reportErrorToObservability } from './services/observability';
import type { Env, QueueMessage } from './types';

export type { Env } from './types';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return handleHttpRequest(request, env);
	},

	async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
		await handleQueueBatch(batch, env);
	},

	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(handleScheduledRenewWatch(env));
	},
};

async function handleScheduledRenewWatch(env: Env): Promise<void> {
	try {
		await renewWatch(env);
	} catch (error: unknown) {
		await reportErrorToObservability(env, 'scheduled.watch_renew_failed', error, {
			schedule: '0 0 */6 * *',
		});
	}
}
