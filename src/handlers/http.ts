import { ROUTE_GMAIL_PUSH, ROUTE_GMAIL_WATCH } from '../constants';
import { renewWatch } from '../services/gmail';
import { enqueueSyncNotification } from '../services/bridge';
import { reportErrorToObservability } from '../services/observability';
import type { Env, PubSubPushBody } from '../types';

/**
 * HTTP handler:
 *   POST /gmail/push?secret=XXX   — 接收 Pub/Sub 推送
 *   POST /gmail/watch?secret=XXX  — 手动触发 watch 注册
 *   GET  /                        — 健康检查
 */
export async function handleHttpRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	try {
		if (request.method === 'POST' && url.pathname === ROUTE_GMAIL_PUSH) {
			return await handleGmailPush(request, url, env);
		}

		if (request.method === 'POST' && url.pathname === ROUTE_GMAIL_WATCH) {
			return await handleWatchRenewal(url, env);
		}

		return new Response('Gmail → Telegram Bridge is running');
	} catch (error: unknown) {
		await reportErrorToObservability(env, 'http.unhandled_error', error, {
			method: request.method,
			pathname: url.pathname,
		});
		return new Response('Internal Server Error', { status: 500 });
	}
}

async function handleGmailPush(request: Request, url: URL, env: Env): Promise<Response> {
	if (!isSecretValid(url, env.GMAIL_PUSH_SECRET)) {
		return new Response('Forbidden', { status: 403 });
	}

	const body = (await request.json()) as PubSubPushBody;
	await enqueueSyncNotification(body, env);
	return new Response('OK');
}

async function handleWatchRenewal(url: URL, env: Env): Promise<Response> {
	if (!isSecretValid(url, env.GMAIL_WATCH_SECRET)) {
		return new Response('Forbidden', { status: 403 });
	}
	try {
		await renewWatch(env);
		return new Response('Watch renewed');
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		await reportErrorToObservability(env, 'http.watch_renew_failed', error, {
			pathname: ROUTE_GMAIL_WATCH,
		});
		return new Response(`Watch failed: ${message}`, { status: 500 });
	}
}

function isSecretValid(url: URL, secret: string): boolean {
	return url.searchParams.get('secret') === secret;
}
