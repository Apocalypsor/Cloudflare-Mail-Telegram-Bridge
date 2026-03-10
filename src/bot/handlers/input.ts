import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { createAccount, getAuthorizedAccount, updateAccount } from '../../db/accounts';
import type { Env } from '../../types';
import { isAdmin } from '../auth';
import { clearBotState, getBotState, setBotState } from '../state';

/**
 * 处理文本消息输入（用于添加/编辑账号的多步骤交互）。
 * 必须在所有 command handler 之后注册，作为 catch-all。
 */
export function registerInputHandler(bot: Bot, env: Env) {
	bot.on('message:text', async (ctx) => {
		const userId = String(ctx.from.id);
		const text = ctx.message.text.trim();

		const state = await getBotState(env, userId);
		if (!state) return;

		const admin = isAdmin(userId, env);

		// ─── 添加账号 ─────────────────────────────────────────────────
		if (state.action === 'add') {
			if (state.step === 'chat_id') {
				if (!/^-?\d+$/.test(text)) {
					await ctx.reply('❌ Chat ID 必须为数字，请重新发送：');
					return;
				}
				await setBotState(env, userId, { action: 'add', step: 'label', chatId: text });
				const kb = new InlineKeyboard().text('⏭ 跳过', 'skiplabel');
				await ctx.reply('请发送标签，或点击跳过：', { reply_markup: kb });
			} else if (state.step === 'label') {
				const label = text === '-' ? undefined : text;
				try {
					const account = await createAccount(env.DB, state.chatId, label, userId);
					await clearBotState(env, userId);

					const kb = new InlineKeyboard().text('查看账号', `acc:${account.id}`).text('账号列表', 'accs');
					await ctx.reply(`✅ 账号已创建 #${account.id}\n\nChat ID: ${state.chatId}${label ? `\n标签: ${label}` : ''}`, {
						reply_markup: kb,
					});
				} catch (err) {
					await clearBotState(env, userId);
					await ctx.reply(`❌ 创建失败: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}

		// ─── 编辑 Chat ID ─────────────────────────────────────────────
		else if (state.action === 'edit_chatid') {
			if (!/^-?\d+$/.test(text)) {
				await ctx.reply('❌ Chat ID 必须为数字，请重新发送：');
				return;
			}
			const account = await getAuthorizedAccount(env.DB, state.accountId, userId, admin);
			if (!account) {
				await clearBotState(env, userId);
				await ctx.reply('❌ 账号不存在或无权访问');
				return;
			}

			try {
				await updateAccount(env.DB, state.accountId, text, account.label);
				await clearBotState(env, userId);
				const kb = new InlineKeyboard().text('查看账号', `acc:${state.accountId}`).text('账号列表', 'accs');
				await ctx.reply(`✅ Chat ID 已更新为 ${text}`, { reply_markup: kb });
			} catch (err) {
				await clearBotState(env, userId);
				await ctx.reply(`❌ 更新失败: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// ─── 编辑标签 ─────────────────────────────────────────────────
		else if (state.action === 'edit_label') {
			const account = await getAuthorizedAccount(env.DB, state.accountId, userId, admin);
			if (!account) {
				await clearBotState(env, userId);
				await ctx.reply('❌ 账号不存在或无权访问');
				return;
			}

			try {
				await updateAccount(env.DB, state.accountId, account.chat_id, text);
				await clearBotState(env, userId);
				const kb = new InlineKeyboard().text('查看账号', `acc:${state.accountId}`).text('账号列表', 'accs');
				await ctx.reply(`✅ 标签已更新为「${text}」`, { reply_markup: kb });
			} catch (err) {
				await clearBotState(env, userId);
				await ctx.reply(`❌ 更新失败: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	});
}
