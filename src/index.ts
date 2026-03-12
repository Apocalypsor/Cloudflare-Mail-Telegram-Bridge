import app from './handlers/hono';
import { handleQueueBatch } from './handlers/queue';
import { renewWatchAll } from './services/email/gmail';
import { checkImapBridgeHealth } from './services/email/imap/bridge';
import { reportErrorToObservability } from './services/observability';
import type { Env, QueueMessage } from './types';

export type { Env } from './types';

export default {
	fetch: app.fetch,

	async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
		await handleQueueBatch(batch, env, ctx);
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(handleScheduled(event, env));
	},
};

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
	const isMidnight = new Date(event.scheduledTime).getUTCHours() === 0;

	await Promise.allSettled([
		// 每小时：检查 IMAP 中间件健康
		checkImapBridgeHealth(env)
			.then((health) => {
				if (health !== null && !health.ok) {
					return reportErrorToObservability(env, 'scheduled.imap_bridge_unhealthy', new Error('IMAP bridge unhealthy'), {
						total: health.total,
						usable: health.usable,
					});
				}
			})
			.catch((error: unknown) =>
				reportErrorToObservability(env, 'scheduled.imap_bridge_health_check_failed', error),
			),
		// 仅凌晨：续订 Gmail watch
		isMidnight
			? renewWatchAll(env).catch((error: unknown) =>
					reportErrorToObservability(env, 'scheduled.watch_renew_failed', error),
				)
			: Promise.resolve(),
	]);
}
