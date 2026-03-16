import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { countFailedEmails, deleteAllFailedEmails, deleteFailedEmail, getAllFailedEmails, getFailedEmail } from '@db/failed-emails';

import { approveUser, deleteUser, getNonAdminUsers, rejectUser } from '@db/users';
import { retryAllFailedEmails, retryFailedEmail } from '@services/bridge';
import { renewWatchAll } from '@services/email/gmail';
import { renewSubscriptionAll } from '@services/email/outlook';
import { reportErrorToObservability } from '@utils/observability';
import type { Env, TelegramUser } from '@/types';
import { isAdmin } from '@bot/auth';
import { formatUserName, userListText } from '@bot/formatters';
import { clearBotState } from '@bot/state';

function userListKeyboard(users: TelegramUser[]): InlineKeyboard {
	const kb = new InlineKeyboard();
	for (const u of users) {
		const name = formatUserName(u);
		if (u.approved === 1) {
			kb.text(`✅ ${name}`, `u:${u.telegram_id}:info`).text('撤回', `u:${u.telegram_id}:r`).text('🗑', `u:${u.telegram_id}:del`);
		} else {
			kb.text(`⏳ ${name}`, `u:${u.telegram_id}:info`).text('批准', `u:${u.telegram_id}:a`).text('🗑', `u:${u.telegram_id}:del`);
		}
		kb.row();
	}
	kb.text('« 返回', 'menu');
	return kb;
}

async function adminMenuKeyboard(env: Env): Promise<InlineKeyboard> {
	const failedCount = await countFailedEmails(env.DB);
	const failedLabel = failedCount > 0 ? `📋 失败邮件 (${failedCount})` : '📋 失败邮件';
	const kb = new InlineKeyboard().text(failedLabel, 'failed').row().text('🔄 续订所有 Watch', 'walla').row();
	if (env.WORKER_URL) {
		kb.url('🔍 HTML 预览工具', `${env.WORKER_URL.replace(/\/$/, '')}/preview`).row();
	}
	kb.text('« 返回', 'menu');
	return kb;
}

function failedEmailListMessage(items: import('@db/failed-emails').FailedEmail[]): { text: string; keyboard: InlineKeyboard } {
	if (items.length === 0) {
		return { text: '📋 失败邮件\n\n暂无记录', keyboard: new InlineKeyboard().text('« 返回', 'admin') };
	}
	const lines = items.map((item, i) => {
		const date = item.created_at.replace('T', ' ').slice(0, 16);
		const subj = item.subject ? (item.subject.length > 30 ? item.subject.slice(0, 30) + '…' : item.subject) : '(无主题)';
		return `${i + 1}. ${subj}\n   ${date} | ${item.error_message?.slice(0, 40) || '未知错误'}`;
	});
	const kb = new InlineKeyboard().text('🔄 全部重试', 'retry_all').text('🗑 全部清空', 'failed_clear').row();
	for (const item of items) {
		const label = item.subject ? (item.subject.length > 15 ? item.subject.slice(0, 15) + '…' : item.subject) : `#${item.id}`;
		kb.text(`🔄 ${label}`, `fr:${item.id}`).text('🗑', `fd:${item.id}`).row();
	}
	kb.text('« 返回', 'admin');
	return { text: `📋 失败邮件 (${items.length})\n\n${lines.join('\n\n')}`, keyboard: kb };
}

export function registerAdminHandlers(bot: Bot, env: Env) {
	// Admin operations menu
	bot.callbackQuery('admin', async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}
		await clearBotState(env, userId);
		await ctx.editMessageText('⚙️ 全局操作', { reply_markup: await adminMenuKeyboard(env) });
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

	// Delete user confirmation
	bot.callbackQuery(/^u:(\d+):del$/, async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}

		const targetId = ctx.match![1];
		const kb = new InlineKeyboard().text('⚠️ 确认删除', `u:${targetId}:dy`).text('取消', 'users');
		await ctx.editMessageText(`确定要删除用户 ${targetId} 吗？\n\n该用户关联的账号绑定将被解除。`, { reply_markup: kb });
		await ctx.answerCallbackQuery();
	});

	// Delete user confirmed
	bot.callbackQuery(/^u:(\d+):dy$/, async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}

		const targetId = ctx.match![1];
		await deleteUser(env.DB, targetId);

		const users = await getNonAdminUsers(env.DB, env.ADMIN_TELEGRAM_ID);
		await ctx.editMessageText(userListText(users), { reply_markup: userListKeyboard(users) });
		await ctx.answerCallbackQuery({ text: '🗑 已删除' });
	});

	// Watch all
	bot.callbackQuery('walla', async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}

		await ctx.answerCallbackQuery({ text: '⏳ 正在续订...' });
		try {
			await Promise.all([renewWatchAll(env), renewSubscriptionAll(env)]);
			await ctx.editMessageText('⚙️ 全局操作\n\n✅ 所有 Watch 已续订', { reply_markup: await adminMenuKeyboard(env) });
		} catch (err) {
			await reportErrorToObservability(env, 'bot.watch_all_failed', err);
			await ctx.editMessageText('⚙️ 全局操作\n\n❌ Watch 续订失败', { reply_markup: await adminMenuKeyboard(env) });
		}
	});

	// ─── Failed emails management ─────────────────────────────────────────

	// List failed emails
	bot.callbackQuery('failed', async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}
		await clearBotState(env, userId);
		const items = await getAllFailedEmails(env.DB);
		const { text, keyboard } = failedEmailListMessage(items);
		await ctx.editMessageText(text, { reply_markup: keyboard });
		await ctx.answerCallbackQuery();
	});

	// Retry all failed emails
	bot.callbackQuery('retry_all', async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}

		await ctx.answerCallbackQuery({ text: '⏳ 正在重试...' });
		try {
			const result = await retryAllFailedEmails(env);
			const msg = `✅ ${result.success} 封成功` + (result.failed > 0 ? `，❌ ${result.failed} 封仍失败` : '');
			await ctx.editMessageText(`📋 失败邮件\n\n${msg}`, {
				reply_markup: new InlineKeyboard().text('📋 刷新列表', 'failed').text('« 返回', 'admin'),
			});
		} catch (err) {
			await reportErrorToObservability(env, 'bot.retry_all_failed', err);
			await ctx.editMessageText('📋 失败邮件\n\n❌ 重试出错', { reply_markup: new InlineKeyboard().text('« 返回', 'failed') });
		}
	});

	// Retry single failed email
	bot.callbackQuery(/^fr:(\d+)$/, async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}

		const id = parseInt(ctx.match![1]);
		const item = await getFailedEmail(env.DB, id);
		if (!item) {
			return ctx.answerCallbackQuery({ text: '记录不存在' });
		}

		await ctx.answerCallbackQuery({ text: '⏳ 正在重试...' });

		try {
			await retryFailedEmail(item, env);
		} catch (err) {
			await reportErrorToObservability(env, 'bot.retry_single_failed', err, { failedEmailId: id });
		}

		// Refresh list
		const items = await getAllFailedEmails(env.DB);
		const { text, keyboard } = failedEmailListMessage(items);
		try {
			await ctx.editMessageText(text, { reply_markup: keyboard });
		} catch {
			// 消息可能已被删除
		}
	});

	// Delete single failed email
	bot.callbackQuery(/^fd:(\d+)$/, async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}

		const id = parseInt(ctx.match![1]);
		await deleteFailedEmail(env.DB, id);
		await ctx.answerCallbackQuery({ text: '🗑 已删除' });

		// Refresh list
		const items = await getAllFailedEmails(env.DB);
		const { text, keyboard } = failedEmailListMessage(items);
		await ctx.editMessageText(text, { reply_markup: keyboard });
	});

	// Clear all failed emails
	bot.callbackQuery('failed_clear', async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) {
			return ctx.answerCallbackQuery({ text: '无权操作' });
		}

		await deleteAllFailedEmails(env.DB);
		await ctx.editMessageText('📋 失败邮件\n\n✅ 已全部清空', { reply_markup: new InlineKeyboard().text('« 返回', 'admin') });
		await ctx.answerCallbackQuery({ text: '已清空' });
	});
}
