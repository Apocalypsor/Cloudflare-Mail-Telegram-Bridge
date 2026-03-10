import { Hono } from 'hono';
import { createBot, getBotInfo } from '../../bot';
import type { AppEnv } from '../../types';
import { timingSafeEqual } from '../../utils/hash';
import { ROUTE_TELEGRAM_WEBHOOK } from './routes';

const telegram = new Hono<AppEnv>();

telegram.post(ROUTE_TELEGRAM_WEBHOOK, async (c) => {
	const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
	const provided = c.req.query('secret');
	if (!secret || !provided || !timingSafeEqual(provided, secret)) {
		return c.text('Forbidden', 403);
	}

	const botInfo = await getBotInfo(c.env);
	const bot = createBot(c.env, botInfo);
	const update = await c.req.json();
	await bot.handleUpdate(update);
	return c.text('OK');
});

export default telegram;
