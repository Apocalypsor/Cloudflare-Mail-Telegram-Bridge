import { Hono } from 'hono';
import { createBot, getBotInfo } from '../../bot';
import type { Env } from '../../types';
import { ROUTE_TELEGRAM_WEBHOOK } from './routes';

const telegram = new Hono<{ Bindings: Env }>();

telegram.post(ROUTE_TELEGRAM_WEBHOOK, async (c) => {
	const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
	if (!secret || c.req.query('secret') !== secret) {
		return c.text('Forbidden', 403);
	}

	const botInfo = await getBotInfo(c.env);
	const bot = createBot(c.env, botInfo);
	const update = await c.req.json();
	await bot.handleUpdate(update);
	return c.text('OK');
});

export default telegram;
