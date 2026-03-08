import type { Env } from '../types';

/** 获取 Telegram Bot Token（所有账号共享同一个 bot） */
export async function getTelegramToken(env: Env): Promise<string> {
	return env.TG_TOKEN.get();
}
