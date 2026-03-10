import { Hono } from 'hono';
import { approveUser, rejectUser } from '../../db/users';
import { sendPlainTextMessage } from '../../services/telegram';
import type { AppEnv } from '../../types';
import { requireAdmin, requireSession } from './middleware';
import { ROUTE_USERS_APPROVE, ROUTE_USERS_REJECT } from './routes';

const users = new Hono<AppEnv>();

users.post(ROUTE_USERS_APPROVE, requireSession(), requireAdmin(), async (c) => {
	const telegramId = c.req.param('telegramId');
	await approveUser(c.env.DB, telegramId);
	try {
		await sendPlainTextMessage(c.env.TELEGRAM_BOT_TOKEN, telegramId, '✅ 您的账号已通过审批，现在可以登录使用了。');
	} catch { /* ignore send failure */ }
	return c.text('OK');
});

users.post(ROUTE_USERS_REJECT, requireSession(), requireAdmin(), async (c) => {
	const telegramId = c.req.param('telegramId');
	await rejectUser(c.env.DB, telegramId);
	return c.text('OK');
});

export default users;
