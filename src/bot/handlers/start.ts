import type { Env } from '@/types';
import { isAdmin } from '@bot/auth';
import { HELP_TEXT } from '@bot/commands';
import { formatUserName } from '@bot/formatters';
import { mainMenuKeyboard } from '@bot/keyboards';
import { approveUser, getUserByTelegramId, rejectUser, upsertUser } from '@db/users';
import { reportErrorToObservability } from '@utils/observability';
import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';

export function registerStartHandlers(bot: Bot, env: Env) {
	// ─── /start: 主入口，自动注册用户 ────────────────────────────────────────
	bot.command('start', async (ctx) => {
		const telegramId = String(ctx.from?.id);
		const admin = isAdmin(telegramId, env);
		let user = await getUserByTelegramId(env.DB, telegramId);

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

			if (!admin) {
				const displayName = formatUserName({ first_name: ctx.from?.first_name || 'Unknown', last_name: ctx.from?.last_name });
				const username = ctx.from?.username ? ` (@${ctx.from.username})` : '';
				try {
					const kb = new InlineKeyboard().text('✅ 批准', `approve:${telegramId}`).text('❌ 拒绝', `reject:${telegramId}`);
					await ctx.api.sendMessage(env.ADMIN_TELEGRAM_ID, `🆕 新用户注册: ${displayName}${username}\nTelegram ID: ${telegramId}`, {
						reply_markup: kb,
					});
				} catch (err) {
					await reportErrorToObservability(env, 'bot.notify_admin_failed', err);
				}
			}
		}

		if (!admin && user && user.approved !== 1) {
			return ctx.reply('您的账号正在等待管理员审批，审批通过后会收到通知。');
		}

		return ctx.reply('💻 Telemail 管理面板', { reply_markup: mainMenuKeyboard(admin) });
	});

	// ─── /help ────────────────────────────────────────────────────────────────
	bot.command('help', async (ctx) => {
		return ctx.reply(HELP_TEXT, { parse_mode: 'MarkdownV2' });
	});

	// ─── Main menu callback ──────────────────────────────────────────────────
	bot.callbackQuery('menu', async (ctx) => {
		const userId = String(ctx.from.id);
		const admin = isAdmin(userId, env);
		await ctx.editMessageText('💻 Telemail 管理面板', { reply_markup: mainMenuKeyboard(admin) });
		await ctx.answerCallbackQuery();
	});

	// ─── 管理员审批 inline 按钮回调 ──────────────────────────────────────────
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
}
