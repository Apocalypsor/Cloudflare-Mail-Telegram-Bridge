import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../types';
import { timingSafeEqual } from '../../utils/hash';

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
