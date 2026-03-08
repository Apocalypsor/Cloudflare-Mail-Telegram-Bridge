import { Hono } from 'hono';
import {
	ROUTE_GMAIL_PUSH,
	ROUTE_GMAIL_WATCH,
	ROUTE_OAUTH_GOOGLE,
	ROUTE_OAUTH_GOOGLE_CALLBACK,
	ROUTE_OAUTH_GOOGLE_START,
	ROUTE_PREVIEW,
} from '../constants';
import { DashboardPage, HomePage, PreviewPage } from '../components/home';
import { OAuthCallbackPage, OAuthErrorPage, OAuthSetupPage } from '../components/oauth';
import { enqueueSyncNotification } from '../services/bridge';
import { renewWatch } from '../services/gmail';
import { convertPreview } from '../services/home';
import { getOAuthPageProps, processOAuthCallback, startGoogleOAuth } from '../services/oauth';
import { reportErrorToObservability } from '../services/observability';
import type { Env, PubSubPushBody } from '../types';
import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const app = new Hono<{ Bindings: Env }>();

// ─── Middleware: secret validation ──────────────────────────────────────────
function requireSecret(secretKey: 'GMAIL_PUSH_SECRET' | 'GMAIL_WATCH_SECRET'): MiddlewareHandler<{ Bindings: Env }> {
	return async (c, next) => {
		if (c.req.query('secret') !== c.env[secretKey]) {
			return c.text('Forbidden', 403);
		}
		await next();
	};
}

// ─── Error handler ──────────────────────────────────────────────────────────
app.onError(async (error, c) => {
	await reportErrorToObservability(c.env, 'http.unhandled_error', error, {
		method: c.req.method,
		pathname: new URL(c.req.url).pathname,
	});
	return c.text('Internal Server Error', 500);
});

// ─── Gmail Pub/Sub push ─────────────────────────────────────────────────────
app.post(ROUTE_GMAIL_PUSH, requireSecret('GMAIL_PUSH_SECRET'), async (c) => {
	const body = await c.req.json<PubSubPushBody>();
	await enqueueSyncNotification(body, c.env);
	return c.text('OK');
});

// ─── Gmail Watch renewal ────────────────────────────────────────────────────
app.post(ROUTE_GMAIL_WATCH, requireSecret('GMAIL_WATCH_SECRET'), async (c) => {
	try {
		await renewWatch(c.env);
		return c.text('Watch renewed');
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		await reportErrorToObservability(c.env, 'http.watch_renew_failed', error, {
			pathname: ROUTE_GMAIL_WATCH,
		});
		return c.text(`Watch failed: ${message}`, 500);
	}
});

// ─── Google OAuth ───────────────────────────────────────────────────────────
app.get(ROUTE_OAUTH_GOOGLE, requireSecret('GMAIL_WATCH_SECRET'), (c) => {
	const props = getOAuthPageProps(c.req.raw, c.env);
	return c.html(<OAuthSetupPage {...props} />);
});

app.get(ROUTE_OAUTH_GOOGLE_START, requireSecret('GMAIL_WATCH_SECRET'), (c) => {
	return startGoogleOAuth(c.req.raw, c.env);
});

app.get(ROUTE_OAUTH_GOOGLE_CALLBACK, async (c) => {
	const result = await processOAuthCallback(c.req.raw, c.env);
	if (!result.ok) {
		return c.html(
			<OAuthErrorPage title={result.title} detail={result.detail} secret={result.secret} />,
			result.status as ContentfulStatusCode,
		);
	}
	return c.html(
		<OAuthCallbackPage
			refreshToken={result.refreshToken}
			scope={result.scope}
			expiresIn={result.expiresIn}
			watchUrl={result.watchUrl}
			secret={result.secret}
		/>,
	);
});

// ─── HTML Preview ───────────────────────────────────────────────────────────
app.get(ROUTE_PREVIEW, requireSecret('GMAIL_WATCH_SECRET'), (c) => {
	return c.html(<PreviewPage secret={c.env.GMAIL_WATCH_SECRET} />);
});

app.post(ROUTE_PREVIEW, requireSecret('GMAIL_WATCH_SECRET'), async (c) => {
	const { html } = await c.req.json<{ html?: string }>();
	if (!html) return c.json({ result: '', length: 0 });
	return c.json(convertPreview(html));
});

// ─── Home / Dashboard ───────────────────────────────────────────────────────
app.post('/', async (c) => {
	const form = await c.req.formData();
	const secret = form.get('secret');
	if (typeof secret !== 'string' || secret !== c.env.GMAIL_WATCH_SECRET) {
		return c.html(<HomePage error="密钥错误，请重试" />, 403);
	}
	return c.html(<DashboardPage secret={secret} />);
});

app.get('/', (c) => {
	if (c.req.query('secret') === c.env.GMAIL_WATCH_SECRET) {
		return c.html(<DashboardPage secret={c.env.GMAIL_WATCH_SECRET} />);
	}
	return c.html(<HomePage />);
});

export default app;
