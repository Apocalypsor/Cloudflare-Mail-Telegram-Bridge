import { Hono } from 'hono';
import { enqueueSyncNotification } from '../../services/bridge';
import { renewWatchAll } from '../../services/gmail';
import { reportErrorToObservability } from '../../services/observability';
import type { Env, PubSubPushBody } from '../../types';
import { requireSecret } from './middleware';
import { ROUTE_GMAIL_PUSH, ROUTE_GMAIL_WATCH } from './routes';

const gmail = new Hono<{ Bindings: Env }>();

gmail.post(ROUTE_GMAIL_PUSH, requireSecret('GMAIL_PUSH_SECRET'), async (c) => {
	const body = await c.req.json<PubSubPushBody>();
	await enqueueSyncNotification(body, c.env);
	return c.text('OK');
});

gmail.post(ROUTE_GMAIL_WATCH, requireSecret('GMAIL_WATCH_SECRET'), async (c) => {
	try {
		await renewWatchAll(c.env);
		return c.text('Watch renewed for all accounts');
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		await reportErrorToObservability(c.env, 'http.watch_renew_failed', error, {
			pathname: ROUTE_GMAIL_WATCH,
		});
		return c.text(`Watch failed: ${message}`, 500);
	}
});

export default gmail;
