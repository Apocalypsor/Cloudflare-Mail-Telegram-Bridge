import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { clearAllKV } from '../../db/kv';
import { approveUser, getNonAdminUsers, rejectUser } from '../../db/users';
import { renewWatchAll } from '../../services/gmail';
import { reportErrorToObservability } from '../../services/observability';
import type { Env, TelegramUser } from '../../types';
import { isAdmin } from '../auth';
import { formatUserName, userListText } from '../formatters';
import { clearBotState } from '../state';

function userListKeyboard(users: TelegramUser[]): InlineKeyboard {
	const kb = new InlineKeyboard();
	for (const u of users) {
		const name = formatUserName(u);
		if (u.approved === 1) {
			kb.text(`✅ ${name}`, `u:${u.telegram_id}:info`).text('撤回', `u:${u.telegram_id}:r`);
		} else {
			kb.text(`⏳ ${name}`, `u:${u.telegram_id}:info`).text('批准', `u:${u.telegram_id}:a`).text('拒绝', `u:${u.telegram_id}:r`);
		}
		kb.row();
	}
	kb.text('« 返回', 'menu');
	return kb;
}

function adminMenuKeyboard(env: Env): InlineKeyboard {
	const kb = new InlineKeyboard()
		.text('🔄 续订所有 Watch', 'walla')
		.row()
		.text('🗑 清空全局 KV 缓存', 'clrkv')
		.row();
	if (env.WORKER_URL) {
		kb.url('🔍 HTML 预览工具', `${env.WORKER_URL.replace(/\/$/, '')}/preview`).row();
	}
	kb.text('« 返回', 'menu');
	return kb;
}

export function registerAdminHandlers(bot: Bot, env: Env) {
	// Admin operations menu
	bot.callbackQuery('admin', async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}
		await clearBotState(env, userId);
		await ctx.editMessageText('⚙️ 全局操作', { reply_markup: adminMenuKeyboard(env) });
		await ctx.answerCallbackQuery();
	});

	// User list
	bot.callbackQuery('users', async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}
		await clearBotState(env, userId);
		const users = await getNonAdminUsers(env.DB, env.ADMIN_TELEGRAM_ID);
		await ctx.editMessageText(userListText(users), { reply_markup: userListKeyboard(users) });
		await ctx.answerCallbackQuery();
	});

	// User info (no-op, just shows toast)
	bot.callbackQuery(/^u:(\d+):info$/, async (ctx) => {
		if (!isAdmin(String(ctx.from.id), env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}
		await ctx.answerCallbackQuery({ text: `Telegram ID: ${ctx.match![1]}` });
	});

	// Approve user
	bot.callbackQuery(/^u:(\d+):a$/, async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}

		const targetId = ctx.match![1];
		await approveUser(env.DB, targetId);

		try {
			await ctx.api.sendMessage(targetId, '✅ 您的账号已被管理员批准！发送 /start 开始使用。');
		} catch {
			/* user may have blocked bot */
		}

		// Refresh user list
		const users = await getNonAdminUsers(env.DB, env.ADMIN_TELEGRAM_ID);
		await ctx.editMessageText(userListText(users), { reply_markup: userListKeyboard(users) });
		await ctx.answerCallbackQuery({ text: '✅ 已批准' });
	});

	// Reject / revoke user
	bot.callbackQuery(/^u:(\d+):r$/, async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}

		const targetId = ctx.match![1];
		await rejectUser(env.DB, targetId);

		try {
			await ctx.api.sendMessage(targetId, '❌ 您的账号权限已被撤回。');
		} catch {
			/* user may have blocked bot */
		}

		// Refresh user list
		const users = await getNonAdminUsers(env.DB, env.ADMIN_TELEGRAM_ID);
		await ctx.editMessageText(userListText(users), { reply_markup: userListKeyboard(users) });
		await ctx.answerCallbackQuery({ text: '已处理' });
	});

	// Watch all
	bot.callbackQuery('walla', async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}

		await ctx.answerCallbackQuery({ text: '⏳ 正在续订...' });
		try {
			await renewWatchAll(env);
			await ctx.editMessageText('⚙️ 全局操作\n\n✅ 所有 Watch 已续订', { reply_markup: adminMenuKeyboard(env) });
		} catch (err) {
			await reportErrorToObservability(env, 'bot.watch_all_failed', err);
			await ctx.editMessageText('⚙️ 全局操作\n\n❌ Watch 续订失败', { reply_markup: adminMenuKeyboard(env) });
		}
	});

	// Clear all KV
	bot.callbackQuery('clrkv', async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}

		await ctx.answerCallbackQuery({ text: '⏳ 正在清理...' });
		try {
			const deleted = await clearAllKV(env);
			await ctx.editMessageText(`⚙️ 全局操作\n\n✅ 已清除 ${deleted} 个 KV 键`, { reply_markup: adminMenuKeyboard(env) });
		} catch (err) {
			await reportErrorToObservability(env, 'bot.clear_kv_failed', err);
			await ctx.editMessageText('⚙️ 全局操作\n\n❌ 清理失败', { reply_markup: adminMenuKeyboard(env) });
		}
	});
}
