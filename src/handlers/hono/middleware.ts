import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@/types';
import { SESSION_COOKIE_NAME } from '@/constants';
import { timingSafeEqual } from '@utils/hash';
import { verifySessionCookie } from '@utils/session';
import { getUserByTelegramId } from '@db/users';
import { ROUTE_LOGIN } from '@handlers/hono/routes';

/** 校验 query param 中的共享密钥（用于 GMAIL_PUSH_SECRET） */
export function requireSecret(secretKey: 'GMAIL_PUSH_SECRET'): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const provided = c.req.query('secret');
		if (!provided || !timingSafeEqual(provided, c.env[secretKey])) {
			return c.text('Forbidden', 403);
		}
		await next();
	};
}

/** 校验 Authorization: Bearer 头（用于 IMAP 中间件） */
export function requireBearer(secretKey: 'IMAP_BRIDGE_SECRET'): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const header = c.req.header('authorization') ?? '';
		const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
		const expected = c.env[secretKey];
		if (!provided || !expected || !timingSafeEqual(provided, expected)) {
			return c.text('Unauthorized', 401);
		}
		await next();
	};
}

/** Telegram Login 会话保护：未登录则跳转登录页 */
export function requireTelegramLogin(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const cookie = getCookie(c, SESSION_COOKIE_NAME);
		if (cookie) {
			const telegramId = await verifySessionCookie(c.env.ADMIN_SECRET, cookie);
			if (telegramId) {
				const user = await getUserByTelegramId(c.env.DB, telegramId);
				if (user && (user.approved || telegramId === c.env.ADMIN_TELEGRAM_ID)) {
					c.set('userId', telegramId);
					c.set('isAdmin', telegramId === c.env.ADMIN_TELEGRAM_ID);
					await next();
					return;
				}
			}
		}
		const returnTo = new URL(c.req.url).pathname + new URL(c.req.url).search;
		const loginUrl = `${ROUTE_LOGIN}?return_to=${encodeURIComponent(returnTo)}`;
		return c.redirect(loginUrl);
	};
}
