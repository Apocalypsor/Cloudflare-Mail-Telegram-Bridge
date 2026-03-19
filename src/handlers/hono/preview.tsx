import { MAX_BODY_CHARS } from '@/constants';
import { AccountType, type AppEnv } from '@/types';
import { JunkCheckPage } from '@components/junk-check';
import { PreviewPage } from '@components/preview';
import { getAccountByEmail, getAccountById } from '@db/accounts';
import { getCachedMailHtml, putCachedMailHtml } from '@db/kv';
import { requireTelegramLogin } from '@handlers/hono/middleware';
import {
	ROUTE_CORS_PROXY,
	ROUTE_JUNK_CHECK,
	ROUTE_JUNK_CHECK_API,
	ROUTE_MAIL,
	ROUTE_PREVIEW,
	ROUTE_PREVIEW_API,
} from '@handlers/hono/routes';
import { fetchRawEmailByType } from '@services/bridge';
import { getAccessToken } from '@services/email/gmail';
import { fetchMailContent, wrapPlainText } from '@services/email/mail-content';
import { analyzeEmail } from '@services/llm';
import { formatBody } from '@utils/format';
import { verifyMailToken, verifyMailTokenById, verifyProxySignature } from '@utils/hash';
import { type CidMap, buildCidMapFromAttachments, proxyImages, replaceCidReferences } from '@utils/html';
import { http } from '@utils/http';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPError } from 'ky';
import PostalMime from 'postal-mime';

const preview = new Hono<AppEnv>();

const loginGuard = requireTelegramLogin();

// ─── HTML 格式化预览工具 ─────────────────────────────────────────────────────

preview.get(ROUTE_PREVIEW, loginGuard, (c) => {
	return c.html(<PreviewPage />);
});

preview.post(ROUTE_PREVIEW_API, loginGuard, async (c) => {
	const { html } = await c.req.json<{ html?: string }>();
	if (!html) return c.json({ result: '', length: 0 });
	const result = formatBody(undefined, html, MAX_BODY_CHARS);
	return c.json({ result, length: result.length });
});

// ─── 垃圾邮件检测工具 ────────────────────────────────────────────────────────

preview.get(ROUTE_JUNK_CHECK, loginGuard, (c) => {
	return c.html(<JunkCheckPage />);
});

preview.post(ROUTE_JUNK_CHECK_API, loginGuard, async (c) => {
	const { subject, body } = await c.req.json<{ subject?: string; body?: string }>();
	if (!c.env.LLM_API_URL || !c.env.LLM_API_KEY || !c.env.LLM_MODEL) return c.json({ error: 'LLM not configured' }, 500);
	const result = await analyzeEmail(c.env.LLM_API_URL, c.env.LLM_API_KEY, c.env.LLM_MODEL, subject ?? '', body ?? '');
	return c.json({ isJunk: result.isJunk, junkConfidence: result.junkConfidence, summary: result.summary, tags: result.tags });
});

// ─── 邮件内容预览 ────────────────────────────────────────────────────────────

preview.get(ROUTE_MAIL, async (c) => {
	const messageId = c.req.param('id');
	const token = c.req.query('t');
	// 新格式：accountId（推荐）；旧格式：email + chatId（向后兼容）
	const accountIdParam = c.req.query('accountId');
	const chatId = c.req.query('chatId');
	const accountEmail = c.req.query('email');

	if (!messageId || !token) return c.text('Missing params', 400);

	let account = null;
	if (accountIdParam) {
		const accountId = Number(accountIdParam);
		if (!Number.isInteger(accountId) || accountId <= 0) return c.text('Invalid accountId', 400);
		const valid = await verifyMailTokenById(c.env.ADMIN_SECRET, messageId, accountId, token);
		if (!valid) return c.text('Forbidden', 403);
		account = await getAccountById(c.env.DB, accountId);
	} else {
		if (!chatId || !accountEmail) return c.text('Missing params', 400);
		const valid = await verifyMailToken(c.env.ADMIN_SECRET, messageId, accountEmail, chatId, token);
		if (!valid) return c.text('Forbidden', 403);
		account = await getAccountByEmail(c.env.DB, accountEmail);
		if (account && account.chat_id !== chatId) account = null;
	}

	if (!account) return c.text('Account not found', 404);

	// KV 缓存（所有类型共用）
	const cached = await getCachedMailHtml(c.env, messageId);
	if (cached) return c.html(await proxyImages(cached, c.env.ADMIN_SECRET));

	let html: string | null = null;
	let cidMap: CidMap = new Map();

	if (account.type === AccountType.Gmail) {
		if (!account.refresh_token) return c.text('Account not authorized', 403);
		const accessToken = await getAccessToken(c.env, account);
		const result = await fetchMailContent(accessToken, messageId);
		if (result) {
			html = result.html;
			cidMap = result.cidMap;
		}
	} else {
		// IMAP + Outlook: 获取原始 MIME 并解析
		if (account.type !== AccountType.Imap && !account.refresh_token) return c.text('Account not authorized', 403);
		const raw = await fetchRawEmailByType(account, messageId, c.env);
		const email = await new PostalMime().parse(raw);
		html = email.html ?? (email.text ? wrapPlainText(email.text) : null);
		cidMap = buildCidMapFromAttachments(email.attachments);
	}

	if (!html) return c.text('No content in this email', 404);

	html = replaceCidReferences(html, cidMap);
	await putCachedMailHtml(c.env, messageId, html);
	return c.html(await proxyImages(html, c.env.ADMIN_SECRET));
});

// ─── 通用 CORS 代理 ────────────────────────────────────────────────────────

preview.get(ROUTE_CORS_PROXY, async (c) => {
	const url = c.req.query('url');
	const sig = c.req.query('sig');
	if (!url || !sig) return c.text('Missing url or sig', 400);
	if (!verifyProxySignature(c.env.ADMIN_SECRET, url, sig)) return c.text('Invalid signature', 403);

	try {
		const resp = await http.get(url);
		const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
		return new Response(resp.body, {
			headers: {
				'content-type': contentType,
				'cache-control': 'public, max-age=86400',
			},
		});
	} catch (err) {
		if (err instanceof HTTPError) return c.text('Upstream error', err.response.status as ContentfulStatusCode);
		return c.text('Failed to fetch image', 502);
	}
});

export default preview;
