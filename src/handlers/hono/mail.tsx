import { Hono } from 'hono';
import { getAccountById } from '../../db/accounts';
import { getCachedMailHtml, putCachedMailHtml } from '../../db/kv';
import { getMessageMappingByGmailId } from '../../db/message-map';
import { getAccessToken } from '../../services/email/gmail';
import { fetchMailContent } from '../../services/mail-content';
import type { AppEnv } from '../../types';
import { verifyMailToken } from '../../utils/hash';
import { ROUTE_MAIL } from './routes';

const mail = new Hono<AppEnv>();

mail.get(ROUTE_MAIL, async (c) => {
	const gmailMessageId = c.req.param('id');
	const token = c.req.query('t');

	if (!token) return c.text('Missing token', 400);

	// 查找消息映射以获取 chatId 和 accountId
	const mapping = await getMessageMappingByGmailId(c.env.DB, gmailMessageId);
	if (!mapping) return c.text('Message not found', 404);

	// 验证 HMAC token
	const valid = await verifyMailToken(c.env.ADMIN_SECRET, gmailMessageId, mapping.tg_chat_id, token);
	if (!valid) return c.text('Forbidden', 403);

	// 尝试从 KV 缓存读取
	const cached = await getCachedMailHtml(c.env, gmailMessageId);
	if (cached) {
		return c.html(cached);
	}

	// 从 Gmail API 实时获取
	const account = await getAccountById(c.env.DB, mapping.account_id);
	if (!account || !account.refresh_token) return c.text('Account not authorized', 403);

	const accessToken = await getAccessToken(c.env, account);
	const html = await fetchMailContent(accessToken, gmailMessageId);

	if (!html) return c.text('No content in this email', 404);

	// 缓存到 KV（7 天）
	await putCachedMailHtml(c.env, gmailMessageId, html);

	return c.html(html);
});

export default mail;
