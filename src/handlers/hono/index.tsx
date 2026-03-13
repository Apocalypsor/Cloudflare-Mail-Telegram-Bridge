import { Hono } from 'hono';
import { FAVICON_BASE64 } from '../../assets/favicon';
import { reportErrorToObservability } from '../../services/observability';
import type { AppEnv } from '../../types';
import gmailOauth from './email/gmail/oauth';
import gmailPush from './email/gmail/push';
import imapRoutes from './email/imap/index';
import msOauth from './email/outlook/oauth';
import outlookPush from './email/outlook/push';
import preview from './preview';
import telegram from './telegram';

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
app.route('', telegram);
app.route('', gmailPush);
app.route('', gmailOauth);
app.route('', outlookPush);
app.route('', msOauth);
app.route('', imapRoutes);
app.route('', preview);

export default app;
