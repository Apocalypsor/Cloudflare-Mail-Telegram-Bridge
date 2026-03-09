import type { MiddlewareHandler } from 'hono';
import type { Env } from '../../types';

export function requireSecret(secretKey: 'GMAIL_PUSH_SECRET' | 'ADMIN_SECRET'): MiddlewareHandler<{ Bindings: Env }> {
	return async (c, next) => {
		if (c.req.query('secret') !== c.env[secretKey]) {
			return c.text('Forbidden', 403);
		}
		await next();
	};
}
