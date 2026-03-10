import { Bot, InlineKeyboard } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { BOT_INFO_TTL, KV_BOT_INFO_KEY } from '../constants';
import { getVisibleAccounts } from '../db/accounts';
import { approveUser, getAllUsers, getUserByTelegramId, rejectUser, upsertUser } from '../db/users';
import { reportErrorToObservability } from '../services/observability';
import { sendPlainTextMessage } from '../services/telegram';
import type { Env } from '../types';
import { isAdmin } from './auth';
import { formatUserName } from './formatters';
import { accountListKeyboard, registerAccountHandlers } from './handlers/accounts';
import { registerAdminHandlers } from './handlers/admin';
import { registerInputHandler } from './handlers/input';
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

function mainMenuKeyboard(admin: boolean): InlineKeyboard {
	const kb = new InlineKeyboard().text('📧 账号管理', 'accs').row();
	if (admin) {
		kb.text('👥 用户管理', 'users').text('⚙️ 全局操作', 'admin').row();
	}
	return kb;
}

/** 创建 grammY Bot 实例（仅用于 webhook 接收端） */
export function createBot(env: Env, botInfo: UserFromGetMe) {
	const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });

	bot.catch(async (err) => {
		await reportErrorToObservability(env, 'bot.handler_error', err.error);
	});

	// ─── /start: 主入口，自动注册用户 ────────────────────────────────────────
	bot.command('start', async (ctx) => {
		const telegramId = String(ctx.from?.id);
		const admin = isAdmin(telegramId, env);
		let user = await getUserByTelegramId(env.DB, telegramId);

		// 首次使用：自动注册用户
		if (!user) {
			await upsertUser(
				env.DB,
				telegramId,
				ctx.from?.first_name || 'Unknown',
				ctx.from?.last_name,
				ctx.from?.username,
				undefined,
				admin ? 1 : 0,
			);
			user = await getUserByTelegramId(env.DB, telegramId);

			// 通知管理员（非管理员注册时）
			if (!admin) {
				const displayName = formatUserName({ first_name: ctx.from?.first_name || 'Unknown', last_name: ctx.from?.last_name });
				const username = ctx.from?.username ? ` (@${ctx.from.username})` : '';
				try {
					await sendPlainTextMessage(
						env.TELEGRAM_BOT_TOKEN,
						env.ADMIN_TELEGRAM_ID,
						`🆕 新用户注册: ${displayName}${username}\nTelegram ID: ${telegramId}`,
						{
							inline_keyboard: [
								[
									{ text: '✅ 批准', callback_data: `approve:${telegramId}` },
									{ text: '❌ 拒绝', callback_data: `reject:${telegramId}` },
								],
							],
						},
					);
				} catch (err) {
					console.error('Failed to notify admin of new registration:', err);
				}
			}
		}

		// 未审批用户
		if (!admin && user && user.approved !== 1) {
			return ctx.reply('您的账号正在等待管理员审批，审批通过后会收到通知。');
		}

		return ctx.reply('📬 Telemail 管理面板', { reply_markup: mainMenuKeyboard(admin) });
	});

	// ─── /accounts: 快速查看账号列表 ────────────────────────────────────────
	bot.command('accounts', async (ctx) => {
		const userId = String(ctx.from?.id);
		const admin = isAdmin(userId, env);

		if (!admin) {
			const user = await getUserByTelegramId(env.DB, userId);
			if (!user || user.approved !== 1) {
				return ctx.reply('您的账号正在等待管理员审批。');
			}
		}

		const accounts = await getVisibleAccounts(env.DB, userId, admin);
		const text = accounts.length > 0 ? `📧 账号列表 (${accounts.length})` : '📧 暂无账号';
		return ctx.reply(text, { reply_markup: accountListKeyboard(accounts) });
	});

	// ─── /users: 快速查看用户列表（管理员） ──────────────────────────────────
	bot.command('users', async (ctx) => {
		const userId = String(ctx.from?.id);
		if (!isAdmin(userId, env)) {
			return ctx.reply('⛔ 仅管理员可用');
		}

		const users = (await getAllUsers(env.DB)).filter((u) => u.telegram_id !== env.ADMIN_TELEGRAM_ID);
		if (users.length === 0) {
			return ctx.reply('👥 暂无用户');
		}

		let text = `👥 用户列表 (${users.length})\n\n`;
		for (const u of users) {
			const status = u.approved === 1 ? '✅' : '⏳';
			const name = formatUserName(u);
			const username = u.username ? ` @${u.username}` : '';
			text += `${status} ${name}${username}\n   ID: ${u.telegram_id}\n`;
		}
		return ctx.reply(text);
	});

	// ─── Main menu callback ────────────────────────────────────────────────
	bot.callbackQuery('menu', async (ctx) => {
		const userId = String(ctx.from.id);
		const admin = isAdmin(userId, env);
		await ctx.editMessageText('📬 Telemail 管理面板', { reply_markup: mainMenuKeyboard(admin) });
		await ctx.answerCallbackQuery();
	});

	// ─── 管理员审批 inline 按钮回调（来自通知消息） ────────────────────────
	bot.callbackQuery(/^(approve|reject):(\d+)$/, async (ctx) => {
		if (!isAdmin(String(ctx.from.id), env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}
		const [, action, targetId] = ctx.match!;
		const user = await getUserByTelegramId(env.DB, targetId);
		if (!user) {
			return ctx.answerCallbackQuery({ text: '用户不存在' });
		}

		if (action === 'approve') {
			await approveUser(env.DB, targetId);
			await ctx.editMessageText(`✅ 已批准: ${formatUserName(user)} (${targetId})`);
			try {
				await ctx.api.sendMessage(targetId, '✅ 您的账号已被管理员批准！发送 /start 开始使用。');
			} catch {
				/* user may have blocked bot */
			}
		} else {
			await rejectUser(env.DB, targetId);
			await ctx.editMessageText(`❌ 已拒绝: ${formatUserName(user)} (${targetId})`);
			try {
				await ctx.api.sendMessage(targetId, '❌ 您的注册申请未通过审批。');
			} catch {
				/* user may have blocked bot */
			}
		}
		return ctx.answerCallbackQuery();
	});

	// ─── 注册各模块 handler ────────────────────────────────────────────────
	registerAccountHandlers(bot, env);
	registerAdminHandlers(bot, env);
	registerReactionHandler(bot, env);
	registerStarHandler(bot, env);
	// 输入处理必须最后注册（catch-all text handler）
	registerInputHandler(bot, env);

	return bot;
}
