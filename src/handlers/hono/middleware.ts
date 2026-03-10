import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../types';
import { timingSafeEqual } from '../../utils/hash';

/** 校验 query param 中的共享密钥（仅用于 GMAIL_PUSH_SECRET） */
export function requireSecret(secretKey: 'GMAIL_PUSH_SECRET'): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const provided = c.req.query('secret');
		if (!provided || !timingSafeEqual(provided, c.env[secretKey])) {
			return c.text('Forbidden', 403);
		}
		await next();
	};
}
