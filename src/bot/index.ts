import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Env } from '../types';
import { reportErrorToObservability } from '../services/observability';
import { registerReactionHandler } from './handlers/reaction';
import { registerStarHandler } from './handlers/star';

export { STAR_KEYBOARD, STARRED_KEYBOARD, starKeyboardWithMailUrl, starredKeyboardWithMailUrl } from './keyboards';

const KV_BOT_INFO_KEY = 'telegram:bot_info';
const BOT_INFO_TTL = 86400 * 30; // 30 days

/** 从 KV 获取 botInfo，首次调用时从 Telegram API 拉取并缓存 */
export async function getBotInfo(env: Env): Promise<UserFromGetMe> {
	const cached = await env.EMAIL_KV.get(KV_BOT_INFO_KEY);
	if (cached) return JSON.parse(cached);

	const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getMe`);
	if (!resp.ok) throw new Error(`getMe failed: ${resp.status} ${await resp.text()}`);
	const data = (await resp.json()) as { result: UserFromGetMe };
	await env.EMAIL_KV.put(KV_BOT_INFO_KEY, JSON.stringify(data.result), { expirationTtl: BOT_INFO_TTL });
	return data.result;
}

/** 创建 grammY Bot 实例（仅用于 webhook 接收端） */
export function createBot(env: Env, botInfo: UserFromGetMe) {
	const bot = new Bot(env.TELEGRAM_TOKEN, { botInfo });

	bot.catch(async (err) => {
		await reportErrorToObservability(env, 'bot.handler_error', err.error);
	});

	bot.command('start', (ctx) => ctx.reply('功能尚未实现，请前往 https://gmail-tg-bridge.apocalypse.workers.dev/ 管理邮箱。'));

	registerReactionHandler(bot, env);
	registerStarHandler(bot, env);

	return bot;
}
