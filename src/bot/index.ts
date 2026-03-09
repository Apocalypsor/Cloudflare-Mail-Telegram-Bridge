import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { BOT_INFO_TTL, KV_BOT_INFO_KEY } from '../constants';
import { approveUser, getUserByTelegramId, rejectUser } from '../db/users';
import { reportErrorToObservability } from '../services/observability';
import type { Env } from '../types';
import { registerReactionHandler } from './handlers/reaction';
import { registerStarHandler } from './handlers/star';

export { STAR_KEYBOARD, starKeyboardWithMailUrl, STARRED_KEYBOARD, starredKeyboardWithMailUrl } from './keyboards';

/** 从 KV 获取 botInfo，首次调用时从 Telegram API 拉取并缓存 */
export async function getBotInfo(env: Env): Promise<UserFromGetMe> {
	const cached = await env.EMAIL_KV.get(KV_BOT_INFO_KEY);
	if (cached) return JSON.parse(cached);

	const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
	if (!resp.ok) throw new Error(`getMe failed: ${resp.status} ${await resp.text()}`);
	const data = (await resp.json()) as { result: UserFromGetMe };
	await env.EMAIL_KV.put(KV_BOT_INFO_KEY, JSON.stringify(data.result), { expirationTtl: BOT_INFO_TTL });
	return data.result;
}

/** 创建 grammY Bot 实例（仅用于 webhook 接收端） */
export function createBot(env: Env, botInfo: UserFromGetMe) {
	const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });

	bot.catch(async (err) => {
		await reportErrorToObservability(env, 'bot.handler_error', err.error);
	});

	bot.command('start', async (ctx) => {
		const url = env.WORKER_URL?.replace(/\/$/, '') || '';
		const telegramId = String(ctx.from?.id);
		const user = await getUserByTelegramId(env.DB, telegramId);
		if (user && user.approved === 0) {
			return ctx.reply('您的账号正在等待管理员审批，审批通过后会收到通知。');
		}
		return ctx.reply(`欢迎使用 Telemail！请前往 ${url} 管理邮箱`);
	});

	// 管理员审批 inline 按钮回调
	bot.callbackQuery(/^(approve|reject):(\d+)$/, async (ctx) => {
		if (String(ctx.from.id) !== env.ADMIN_TELEGRAM_ID) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}
		const [, action, targetId] = ctx.match!;
		const user = await getUserByTelegramId(env.DB, targetId);
		if (!user) {
			return ctx.answerCallbackQuery({ text: '用户不存在' });
		}

		if (action === 'approve') {
			await approveUser(env.DB, targetId);
			const url = env.WORKER_URL?.replace(/\/$/, '') || '';
			await ctx.editMessageText(`✅ 已批准: ${user.first_name}${user.last_name ? ` ${user.last_name}` : ''} (${targetId})`);
			try {
				await ctx.api.sendMessage(targetId, `✅ 您的账号已被管理员批准！请前往 ${url} 开始使用。`);
			} catch { /* user may have blocked bot */ }
		} else {
			await rejectUser(env.DB, targetId);
			await ctx.editMessageText(`❌ 已拒绝: ${user.first_name}${user.last_name ? ` ${user.last_name}` : ''} (${targetId})`);
			try {
				await ctx.api.sendMessage(targetId, '❌ 您的注册申请未通过审批。');
			} catch { /* user may have blocked bot */ }
		}
		return ctx.answerCallbackQuery();
	});

	registerReactionHandler(bot, env);
	registerStarHandler(bot, env);

	return bot;
}
