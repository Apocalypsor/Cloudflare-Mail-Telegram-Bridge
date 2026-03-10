import { GMAIL_MODIFY_SCOPE, GOOGLE_OAUTH_AUTHORIZE_URL, GOOGLE_OAUTH_TOKEN_URL, KV_OAUTH_STATE_PREFIX, OAUTH_STATE_TTL_SECONDS } from '../constants';
import { ROUTE_OAUTH_GOOGLE_CALLBACK, ROUTE_OAUTH_GOOGLE_START } from '../handlers/hono/routes';
import type { Env } from '../types';
import { getAccountById, updateAccountEmail, updateRefreshToken } from '../db/accounts';
import { putCachedAccessToken } from '../db/kv';
import { renewWatch } from './gmail';

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

export function getOAuthPageProps(request: Request, accountId: number, accountEmail: string) {
	const origin = new URL(request.url).origin;
	const startUrl = new URL(ROUTE_OAUTH_GOOGLE_START, origin);
	startUrl.searchParams.set('account', String(accountId));

	return {
		startUrl: startUrl.toString(),
		callbackUrl: getCallbackUrl(origin),
		accountEmail,
	};
}

/** 生成 Google OAuth 授权 URL（可用于 web 重定向或 bot 内联按钮） */
export async function generateOAuthUrl(env: Env, accountId: number, origin: string): Promise<string> {
	const state = crypto.randomUUID();
	await env.EMAIL_KV.put(`${KV_OAUTH_STATE_PREFIX}${state}`, String(accountId), {
		expirationTtl: OAUTH_STATE_TTL_SECONDS,
	});

	const redirectUri = getCallbackUrl(origin);
	const authUrl = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
	authUrl.searchParams.set('client_id', env.GMAIL_CLIENT_ID);
	authUrl.searchParams.set('redirect_uri', redirectUri);
	authUrl.searchParams.set('response_type', 'code');
	authUrl.searchParams.set('scope', GMAIL_MODIFY_SCOPE);
	authUrl.searchParams.set('access_type', 'offline');
	authUrl.searchParams.set('prompt', 'consent');
	authUrl.searchParams.set('include_granted_scopes', 'true');
	authUrl.searchParams.set('state', state);

	return authUrl.toString();
}

export async function startGoogleOAuth(request: Request, env: Env, accountId: number): Promise<Response> {
	const requestUrl = new URL(request.url);
	const url = await generateOAuthUrl(env, accountId, requestUrl.origin);
	return Response.redirect(url, 302);
}

type OAuthCallbackResult =
	| { ok: true; refreshToken: string | undefined; scope: string; expiresIn: number | undefined; accountEmail: string; accountId: number; ownerTelegramId: string | null }
	| { ok: false; title: string; detail: string; status: number };

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
			status: 400,
		};
	}

	if (!code || !state) {
		return {
			ok: false,
			title: '参数缺失',
			detail: '回调中没有 code 或 state。',
			status: 400,
		};
	}

	const stateKey = `${KV_OAUTH_STATE_PREFIX}${state}`;
	const accountIdStr = await env.EMAIL_KV.get(stateKey);
	if (!accountIdStr) {
		return {
			ok: false,
			title: 'state 无效',
			detail: '授权会话已过期或不匹配，请重新发起授权。',
			status: 400,
		};
	}

	const accountId = parseInt(accountIdStr, 10);
	if (isNaN(accountId) || accountId <= 0) {
		return { ok: false, title: '参数无效', detail: 'Invalid account ID in state.', status: 400 };
	}
	const account = await getAccountById(env.DB, accountId);
	let accountEmail = account?.email || 'unknown';

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
			status: tokenResp.status,
		};
	}

	const refreshToken = tokenData.refresh_token;
	if (account) {
		const updates: Promise<void>[] = [];
		if (refreshToken) {
			updates.push(updateRefreshToken(env.DB, account.id, refreshToken));
		}
		// 用 access_token 从 Gmail API 获取真实邮箱地址
		if (tokenData.access_token) {
			try {
				const profileResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
					headers: { Authorization: `Bearer ${tokenData.access_token}` },
				});
				if (profileResp.ok) {
					const profile = (await profileResp.json()) as { emailAddress?: string };
					if (profile.emailAddress) {
						accountEmail = profile.emailAddress;
						updates.push(updateAccountEmail(env.DB, account.id, profile.emailAddress));
					}
				}
			} catch {
				// 获取邮箱失败不影响主流程
			}
		}
		await Promise.all(updates);

		// 缓存 access_token 到 KV，供后续 renewWatch 直接使用
		if (tokenData.access_token && tokenData.expires_in) {
			await putCachedAccessToken(env, account.id, tokenData.access_token, Math.max(tokenData.expires_in - 120, 60));
		}

		// 授权完成后自动 watch，用户无需手动点击
		if (refreshToken || account.refresh_token) {
			try {
				const freshAccount = { ...account, refresh_token: (refreshToken || account.refresh_token)!, email: accountEmail !== 'unknown' ? accountEmail : account.email };
				await renewWatch(env, freshAccount);
				console.log(`Auto-watch activated for ${accountEmail}`);
			} catch (err) {
				console.warn(`Auto-watch failed for ${accountEmail}:`, err);
			}
		}
	}

	return {
		ok: true,
		refreshToken,
		scope: tokenData.scope || GMAIL_MODIFY_SCOPE,
		expiresIn: tokenData.expires_in,
		accountEmail,
		accountId,
		ownerTelegramId: account?.telegram_user_id ?? null,
	};
}
