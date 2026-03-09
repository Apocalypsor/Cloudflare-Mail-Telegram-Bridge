import { SESSION_COOKIE, SESSION_TTL } from '../constants';
import { timingSafeEqual } from './hash';

interface SessionPayload {
	/** Telegram user ID */
	uid: number;
	/** Expiry timestamp (seconds) */
	exp: number;
}

async function hmacSign(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/** 创建签名 session token */
export async function createSessionToken(secret: string, telegramUserId: number): Promise<string> {
	const payload: SessionPayload = { uid: telegramUserId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL };
	const json = JSON.stringify(payload);
	const b64 = btoa(json);
	const sig = await hmacSign(secret, b64);
	return `${b64}.${sig}`;
}

/** 验证 session token，返回 Telegram user ID 或 null */
export async function verifySessionToken(secret: string, token: string): Promise<number | null> {
	const dot = token.indexOf('.');
	if (dot < 0) return null;

	const b64 = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	const expected = await hmacSign(secret, b64);
	if (!timingSafeEqual(sig, expected)) return null;

	try {
		const payload: SessionPayload = JSON.parse(atob(b64));
		if (payload.exp < Math.floor(Date.now() / 1000)) return null;
		return payload.uid;
	} catch {
		return null;
	}
}

/** 生成 Set-Cookie header value */
export function sessionCookieHeader(token: string): string {
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`;
}

/** 生成清除 cookie 的 header value */
export function clearSessionCookieHeader(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** 从 Cookie header 中提取 session token */
export function getSessionTokenFromCookie(cookieHeader: string | undefined): string | null {
	if (!cookieHeader) return null;
	const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]*)`));
	return match ? match[1] : null;
}
