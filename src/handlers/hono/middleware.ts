import type { MiddlewareHandler } from 'hono';
import { getSessionTokenFromCookie, verifySessionToken } from '../../utils/session';
import type { Env } from '../../types';

/** 校验 query param 中的共享密钥（仅用于 GMAIL_PUSH_SECRET） */
export function requireSecret(secretKey: 'GMAIL_PUSH_SECRET'): MiddlewareHandler<{ Bindings: Env }> {
	return async (c, next) => {
		if (c.req.query('secret') !== c.env[secretKey]) {
			return c.text('Forbidden', 403);
		}
		await next();
	};
}

/** 校验 Telegram Login session cookie */
export function requireSession(): MiddlewareHandler<{ Bindings: Env }> {
	return async (c, next) => {
		const token = getSessionTokenFromCookie(c.req.header('cookie'));
		const uid = token ? await verifySessionToken(c.env.ADMIN_SECRET, token) : null;
		if (!uid) {
			// GET（页面导航）→ 重定向到登录页；POST（API/fetch）→ 401
			return c.req.method === 'GET' ? c.redirect('/') : c.text('Unauthorized', 401);
		}
		await next();
	};
}
