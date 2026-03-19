import { Hono } from 'hono';
import { FAVICON_BASE64 } from '@assets/favicon';
import { reportErrorToObservability } from '@utils/observability';
import type { AppEnv } from '@/types';
import auth from '@handlers/hono/auth';
import gmailOauth from '@handlers/hono/email/gmail/oauth';
import gmailPush from '@handlers/hono/email/gmail/push';
import imapRoutes from '@handlers/hono/email/imap/index';
import msOauth from '@handlers/hono/email/outlook/oauth';
import outlookPush from '@handlers/hono/email/outlook/push';
import preview from '@handlers/hono/preview';
import telegram from '@handlers/hono/telegram';
const app = new Hono<AppEnv>();

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
app.route('', auth);
app.route('', telegram);
app.route('', gmailPush);
app.route('', gmailOauth);
app.route('', outlookPush);
app.route('', msOauth);
app.route('', imapRoutes);
app.route('', preview);

export default app;
