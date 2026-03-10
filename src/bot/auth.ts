import type { Env } from '../types';

export function isAdmin(userId: string, env: Env): boolean {
	return userId === env.ADMIN_TELEGRAM_ID;
}
