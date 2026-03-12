import { Hono } from 'hono';
import { enqueueOutlookNotification, type GraphNotification } from '../../../../services/email/outlook/sync';
import type { AppEnv } from '../../../../types';
import { timingSafeEqual } from '../../../../utils/hash';
import { ROUTE_OUTLOOK_PUSH } from '../../routes';

const outlookPush = new Hono<AppEnv>();

outlookPush.post(ROUTE_OUTLOOK_PUSH, async (c) => {
	// Graph subscription validation handshake
	const validationToken = c.req.query('validationToken');
	if (validationToken) {
		return c.text(validationToken, 200, { 'Content-Type': 'text/plain' });
	}

	// 校验 secret
	const provided = c.req.query('secret');
	if (!provided || !c.env.MS_WEBHOOK_SECRET || !timingSafeEqual(provided, c.env.MS_WEBHOOK_SECRET)) {
		return c.text('Forbidden', 403);
	}

	const body = await c.req.json<GraphNotification>();
	await enqueueOutlookNotification(body, c.env);
	return c.text('OK');
});

export default outlookPush;
