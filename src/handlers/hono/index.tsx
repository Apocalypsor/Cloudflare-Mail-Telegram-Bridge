import { Hono } from 'hono';
import { FAVICON_BASE64 } from '../../assets/favicon';
import { DashboardPage, HomePage } from '../../components/home';
import { getAllAccounts } from '../../db/accounts';
import { reportErrorToObservability } from '../../services/observability';
import type { Env } from '../../types';
import accounts from './accounts';
import gmail from './gmail';
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

// ─── Home / Dashboard ───────────────────────────────────────────────────────
app.post('/', async (c) => {
	const form = await c.req.formData();
	const secret = form.get('secret');
	if (typeof secret !== 'string' || secret !== c.env.GMAIL_WATCH_SECRET) {
		return c.html(<HomePage error="密钥错误，请重试" />, 403);
	}
	const allAccounts = await getAllAccounts(c.env.DB);
	return c.html(<DashboardPage secret={secret} accounts={allAccounts} />);
});

app.get('/', async (c) => {
	if (c.req.query('secret') === c.env.GMAIL_WATCH_SECRET) {
		const allAccounts = await getAllAccounts(c.env.DB);
		return c.html(<DashboardPage secret={c.env.GMAIL_WATCH_SECRET} accounts={allAccounts} />);
	}
	return c.html(<HomePage />);
});

export default app;
