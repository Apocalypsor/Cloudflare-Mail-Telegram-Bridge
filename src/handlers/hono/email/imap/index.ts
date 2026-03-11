import { Hono } from 'hono';
import { getImapAccounts } from '../../../../db/accounts';
import type { AppEnv } from '../../../../types';
import { requireBearer } from '../../middleware';
import { ROUTE_IMAP_ACCOUNTS, ROUTE_IMAP_PUSH } from '../../routes';

const imap = new Hono<AppEnv>();

/**
 * GET /api/imap/accounts
 * 中间件调用此接口拉取最新的 IMAP 账号列表。
 */
imap.get(ROUTE_IMAP_ACCOUNTS, requireBearer('IMAP_BRIDGE_SECRET'), async (c) => {
	const accounts = await getImapAccounts(c.env.DB);
	return c.json(
		accounts.map((acc) => ({
			id: acc.id,
			email: acc.email,
			chat_id: acc.chat_id,
			imap_host: acc.imap_host,
			imap_port: acc.imap_port,
			imap_secure: !!acc.imap_secure,
			imap_user: acc.imap_user,
			imap_pass: acc.imap_pass,
		})),
	);
});

/**
 * POST /api/imap/push
 * Body: { accountId: number, messageId: string }
 * 中间件检测到新邮件时调用，messageId 为 IMAP UID（字符串）。
 * Worker 将消息入队，由 queue consumer 按需从中间件拉取原文处理。
 */
imap.post(ROUTE_IMAP_PUSH, requireBearer('IMAP_BRIDGE_SECRET'), async (c) => {
	const { accountId, messageId } = await c.req.json<{
		accountId: number;
		messageId: string;
	}>();

	if (!accountId || !messageId) {
		return c.json({ error: 'Missing required fields: accountId, messageId' }, 400);
	}

	await c.env.EMAIL_QUEUE.send({ accountId, messageId });
	return c.text('OK');
});

export default imap;
