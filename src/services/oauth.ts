import {
	GOOGLE_OAUTH_TOKEN_URL,
	KV_GMAIL_REFRESH_TOKEN,
	KV_OAUTH_STATE_PREFIX,
	ROUTE_GMAIL_WATCH,
	ROUTE_OAUTH_GOOGLE_CALLBACK,
	ROUTE_OAUTH_GOOGLE_START,
} from '../constants';
import type { Env } from '../types';

const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export type GoogleTokenResponse = {
	access_token?: string;
	expires_in?: number;
	refresh_token?: string;
	scope?: string;
	token_type?: string;
	error?: string;
	error_description?: string;
};

function getCallbackUrl(origin: string): string {
	return new URL(ROUTE_OAUTH_GOOGLE_CALLBACK, origin).toString();
}

function getWatchUrl(origin: string, secret: string): URL {
	const url = new URL(ROUTE_GMAIL_WATCH, origin);
	url.searchParams.set('secret', secret);
	return url;
}

export function getOAuthPageProps(request: Request, env: Env) {
	const origin = new URL(request.url).origin;
	const startUrl = new URL(ROUTE_OAUTH_GOOGLE_START, origin);
	startUrl.searchParams.set('secret', env.GMAIL_WATCH_SECRET);

	return {
		startUrl: startUrl.toString(),
		callbackUrl: getCallbackUrl(origin),
		watchUrl: getWatchUrl(origin, env.GMAIL_WATCH_SECRET).toString(),
		secret: env.GMAIL_WATCH_SECRET,
	};
}

export async function startGoogleOAuth(request: Request, env: Env): Promise<Response> {
	const requestUrl = new URL(request.url);
	const state = crypto.randomUUID();
	await env.EMAIL_KV.put(`${KV_OAUTH_STATE_PREFIX}${state}`, '1', {
		expirationTtl: OAUTH_STATE_TTL_SECONDS,
	});

	const redirectUri = getCallbackUrl(requestUrl.origin);
	const authUrl = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
	authUrl.searchParams.set('client_id', env.GMAIL_CLIENT_ID);
	authUrl.searchParams.set('redirect_uri', redirectUri);
	authUrl.searchParams.set('response_type', 'code');
	authUrl.searchParams.set('scope', GMAIL_READONLY_SCOPE);
	authUrl.searchParams.set('access_type', 'offline');
	authUrl.searchParams.set('prompt', 'consent');
	authUrl.searchParams.set('include_granted_scopes', 'true');
	authUrl.searchParams.set('state', state);

	return Response.redirect(authUrl.toString(), 302);
}

export type OAuthCallbackResult =
	| { ok: true; refreshToken: string | undefined; scope: string; expiresIn: number | undefined; watchUrl: string; secret: string }
	| { ok: false; title: string; detail: string; secret: string; status: number };

export async function processOAuthCallback(request: Request, env: Env): Promise<OAuthCallbackResult> {
	const requestUrl = new URL(request.url);
	const code = requestUrl.searchParams.get('code');
	const state = requestUrl.searchParams.get('state');
	const oauthError = requestUrl.searchParams.get('error');

	if (oauthError) {
		return {
			ok: false,
			title: 'Google OAuth 授权失败',
			detail: requestUrl.searchParams.get('error_description') || oauthError,
			secret: env.GMAIL_WATCH_SECRET,
			status: 400,
		};
	}

	if (!code || !state) {
		return {
			ok: false,
			title: '参数缺失',
			detail: '回调中没有 code 或 state。',
			secret: env.GMAIL_WATCH_SECRET,
			status: 400,
		};
	}

	const stateKey = `${KV_OAUTH_STATE_PREFIX}${state}`;
	const stateExists = await env.EMAIL_KV.get(stateKey);
	if (!stateExists) {
		return {
			ok: false,
			title: 'state 无效',
			detail: '授权会话已过期或不匹配，请重新发起授权。',
			secret: env.GMAIL_WATCH_SECRET,
			status: 400,
		};
	}

	const redirectUri = getCallbackUrl(requestUrl.origin);
	const [, tokenResp] = await Promise.all([
		env.EMAIL_KV.delete(stateKey),
		fetch(GOOGLE_OAUTH_TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				code,
				client_id: env.GMAIL_CLIENT_ID,
				client_secret: env.GMAIL_CLIENT_SECRET,
				redirect_uri: redirectUri,
				grant_type: 'authorization_code',
			}),
		}),
	]);

	const rawBody = await tokenResp.text();
	let tokenData: GoogleTokenResponse = {};
	try {
		tokenData = JSON.parse(rawBody) as GoogleTokenResponse;
	} catch {
		/* non-JSON response */
	}

	if (!tokenResp.ok) {
		return {
			ok: false,
			title: 'Token 交换失败',
			detail: rawBody || `${tokenResp.status} ${tokenResp.statusText}`,
			secret: env.GMAIL_WATCH_SECRET,
			status: tokenResp.status,
		};
	}

	const refreshToken = tokenData.refresh_token;
	if (refreshToken) {
		await env.EMAIL_KV.put(KV_GMAIL_REFRESH_TOKEN, refreshToken);
	}

	return {
		ok: true,
		refreshToken,
		scope: tokenData.scope || GMAIL_READONLY_SCOPE,
		expiresIn: tokenData.expires_in,
		watchUrl: getWatchUrl(requestUrl.origin, env.GMAIL_WATCH_SECRET).toString(),
		secret: env.GMAIL_WATCH_SECRET,
	};
}
