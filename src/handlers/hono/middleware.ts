import type { MiddlewareHandler } from 'hono';
import { getUserByTelegramId } from '../../db/users';
import { getSessionTokenFromCookie, verifySessionToken } from '../../utils/session';
import type { AppEnv } from '../../types';

/** 校验 query param 中的共享密钥（仅用于 GMAIL_PUSH_SECRET） */
export function requireSecret(secretKey: 'GMAIL_PUSH_SECRET'): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		if (c.req.query('secret') !== c.env[secretKey]) {
			return c.text('Forbidden', 403);
		}
		await next();
	};
}

/** 校验 Telegram Login session cookie，设置 userId / isAdmin 到 context，同时检查用户审批状态 */
export function requireSession(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const token = getSessionTokenFromCookie(c.req.header('cookie'));
		const uid = token ? await verifySessionToken(c.env.ADMIN_SECRET, token) : null;
		if (!uid) {
			return c.req.method === 'GET' ? c.redirect('/') : c.text('Unauthorized', 401);
		}
		const userId = String(uid);
		const isAdmin = userId === c.env.ADMIN_TELEGRAM_ID;

		if (!isAdmin) {
			const user = await getUserByTelegramId(c.env.DB, userId);
			if (!user || user.approved !== 1) {
				return c.req.method === 'GET' ? c.redirect('/') : c.text('Account pending approval', 403);
			}
		}

		c.set('userId', userId);
		c.set('isAdmin', isAdmin);
		await next();
	};
}

/** 仅管理员可访问，必须在 requireSession() 之后使用 */
export function requireAdmin(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		if (!c.get('isAdmin')) {
			return c.req.method === 'GET' ? c.redirect('/') : c.text('Forbidden', 403);
		}
		await next();
	};
}
