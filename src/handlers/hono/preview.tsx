import { Hono } from 'hono';
import PostalMime from 'postal-mime';
import { MAX_BODY_CHARS } from '../../constants';
import { PreviewPage } from '../../components/preview';
import { getAccountByEmail } from '../../db/accounts';
import { getCachedMailHtml, putCachedMailHtml } from '../../db/kv';
import { fetchRawEmailByType } from '../../services/bridge';
import { getAccessToken } from '../../services/email/gmail';
import { fetchMailContent, wrapPlainText } from '../../services/mail-content';
import { AccountType, type AppEnv } from '../../types';
import { formatBody } from '../../utils/format';
import { verifyMailToken } from '../../utils/hash';
import { ROUTE_MAIL, ROUTE_PREVIEW, ROUTE_PREVIEW_API } from './routes';

const preview = new Hono<AppEnv>();

// ─── HTML 格式化预览工具 ─────────────────────────────────────────────────────

preview.get(ROUTE_PREVIEW, (c) => {
	return c.html(<PreviewPage />);
});

preview.post(ROUTE_PREVIEW_API, async (c) => {
	const { html } = await c.req.json<{ html?: string }>();
	if (!html) return c.json({ result: '', length: 0 });
	const result = formatBody(undefined, html, MAX_BODY_CHARS);
	return c.json({ result, length: result.length });
});

// ─── 邮件内容预览 ────────────────────────────────────────────────────────────

preview.get(ROUTE_MAIL, async (c) => {
	const messageId = c.req.param('id');
	const token = c.req.query('t');
	const chatId = c.req.query('chatId');
	const accountEmail = c.req.query('email');

	if (!messageId || !token || !chatId || !accountEmail) return c.text('Missing params', 400);

	const valid = await verifyMailToken(c.env.ADMIN_SECRET, messageId, accountEmail, chatId, token);
	if (!valid) return c.text('Forbidden', 403);

	// KV 缓存（所有类型共用）
	const cached = await getCachedMailHtml(c.env, messageId);
	if (cached) return c.html(cached);

	const account = await getAccountByEmail(c.env.DB, accountEmail);
	if (!account || account.chat_id !== chatId) return c.text('Account not found', 404);

	let html: string | null = null;

	if (account.type === AccountType.Gmail) {
		if (!account.refresh_token) return c.text('Account not authorized', 403);
		const accessToken = await getAccessToken(c.env, account);
		html = await fetchMailContent(accessToken, messageId);
	} else {
		// IMAP + Outlook: 获取原始 MIME 并解析
		if (account.type !== AccountType.Imap && !account.refresh_token) return c.text('Account not authorized', 403);
		const raw = await fetchRawEmailByType(account, messageId, c.env);
		const email = await new PostalMime().parse(raw);
		html = email.html ?? (email.text ? wrapPlainText(email.text) : null);
	}

	if (!html) return c.text('No content in this email', 404);

	await putCachedMailHtml(c.env, messageId, html);
	return c.html(html);
});

export default preview;
