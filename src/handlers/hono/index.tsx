import { Hono } from 'hono';
import { FAVICON_BASE64 } from '../../assets/favicon';
import { DashboardPage, HomePage } from '../../components/home';
import { getAllAccounts } from '../../db/accounts';
import { reportErrorToObservability } from '../../services/observability';
import type { Env } from '../../types';
import { clearSessionCookieHeader, createSessionToken, getSessionTokenFromCookie, sessionCookieHeader, verifySessionToken } from '../../utils/session';
import { parseTelegramLoginParams, verifyTelegramLogin } from '../../utils/telegram-login';
import accounts from './accounts';
import gmail from './gmail';
import mail from './mail';
import oauth from './oauth';
import preview from './preview';
import telegram from './telegram';

const app = new Hono<{ Bindings: Env }>();

// ─── Favicon ─────────────────────────────────────────────────────────────────
const faviconBuf = Uint8Array.from(atob(FAVICON_BASE64), (c) => c.charCodeAt(0));
app.get('/favicon.png', (c) => {
	return c.body(faviconBuf, 200, {
		'Content-Type': 'image/png',
		'Cache-Control': 'public, max-age=604800, immutable',
	});
});

// ─── Error handler ──────────────────────────────────────────────────────────
app.onError(async (error, c) => {
	await reportErrorToObservability(c.env, 'http.unhandled_error', error, {
		method: c.req.method,
		pathname: new URL(c.req.url).pathname,
	});
	return c.text('Internal Server Error', 500);
});

// ─── Mount sub-routers ──────────────────────────────────────────────────────
app.route('', telegram);
app.route('', gmail);
app.route('', accounts);
app.route('', oauth);
app.route('', preview);
app.route('', mail);

// ─── Telegram Login callback ────────────────────────────────────────────────
app.get('/auth/telegram', async (c) => {
	const data = parseTelegramLoginParams(new URL(c.req.url).searchParams);
	if (!data) {
		return c.html(<HomePage botUsername={c.env.TELEGRAM_BOT_USERNAME} error="无效的登录数据" />, 400);
	}

	const valid = await verifyTelegramLogin(c.env.TELEGRAM_TOKEN, data);
	if (!valid) {
		return c.html(<HomePage botUsername={c.env.TELEGRAM_BOT_USERNAME} error="登录验证失败" />, 403);
	}

	if (String(data.id) !== c.env.ADMIN_TELEGRAM_ID) {
		return c.html(<HomePage botUsername={c.env.TELEGRAM_BOT_USERNAME} error="您没有管理员权限" />, 403);
	}

	const token = await createSessionToken(c.env.ADMIN_SECRET, data.id);
	c.header('Set-Cookie', sessionCookieHeader(token));
	return c.redirect('/');
});

// ─── Logout ─────────────────────────────────────────────────────────────────
app.get('/logout', (c) => {
	c.header('Set-Cookie', clearSessionCookieHeader());
	return c.redirect('/');
});

// ─── Home / Dashboard ───────────────────────────────────────────────────────
app.get('/', async (c) => {
	const sessionToken = getSessionTokenFromCookie(c.req.header('cookie'));
	if (sessionToken) {
		const uid = await verifySessionToken(c.env.ADMIN_SECRET, sessionToken);
		if (uid) {
			const allAccounts = await getAllAccounts(c.env.DB);
			return c.html(<DashboardPage accounts={allAccounts} />);
		}
	}
	return c.html(<HomePage botUsername={c.env.TELEGRAM_BOT_USERNAME} />);
});

export default app;
