import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { createAccount, createImapAccount, getAuthorizedAccount, updateAccount } from '../../db/accounts';
import { syncAccounts } from '../../services/email/imap/bridge';
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

		// ─── 添加账号：chat_id / label 步骤 ──────────────────────────
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
				await setBotState(env, userId, { action: 'add', step: 'type', chatId: state.chatId, label });
				const kb = new InlineKeyboard()
					.text('📨 Gmail (OAuth)', 'addtype:gmail')
					.row()
					.text('📬 IMAP', 'addtype:imap')
					.row()
					.text('❌ 取消', 'accs');
				await ctx.reply('请选择账号类型：', { reply_markup: kb });
			}
		}

		// ─── 添加 IMAP 账号：各步骤 ───────────────────────────────────
		else if (state.action === 'add_imap') {
			if (state.step === 'host') {
				if (!text) {
					await ctx.reply('❌ 服务器地址不能为空，请重新发送：');
					return;
				}
				await setBotState(env, userId, { ...state, step: 'port', imapHost: text });
				const kb = new InlineKeyboard().text('❌ 取消', 'accs');
				await ctx.reply(`服务器: ${text}\n\n请发送 IMAP 端口（如 993 for TLS，143 for STARTTLS）：`, { reply_markup: kb });
			} else if (state.step === 'port') {
				const port = parseInt(text, 10);
				if (isNaN(port) || port < 1 || port > 65535) {
					await ctx.reply('❌ 端口必须为 1–65535 之间的数字，请重新发送：');
					return;
				}
				await setBotState(env, userId, { ...state, step: 'secure', imapPort: port });
				const kb = new InlineKeyboard()
					.text('✅ 是（TLS/SSL）', 'imapsecure:yes')
					.text('❌ 否', 'imapsecure:no')
					.row()
					.text('取消', 'accs');
				await ctx.reply(`服务器: ${state.imapHost}:${port}\n\n是否使用 TLS/SSL 加密？`, { reply_markup: kb });
			} else if (state.step === 'user') {
				if (!text) {
					await ctx.reply('❌ 用户名不能为空，请重新发送：');
					return;
				}
				await setBotState(env, userId, { ...state, step: 'pass', imapUser: text });
				const kb = new InlineKeyboard().text('❌ 取消', 'accs');
				await ctx.reply('请发送 IMAP 密码：', { reply_markup: kb });
			} else if (state.step === 'pass') {
				if (!text) {
					await ctx.reply('❌ 密码不能为空，请重新发送：');
					return;
				}
				try {
					const account = await createImapAccount(env.DB, {
						chatId: state.chatId,
						label: state.label,
						telegramUserId: userId,
						email: state.imapUser,
						imapHost: state.imapHost,
						imapPort: state.imapPort,
						imapSecure: state.imapSecure ? 1 : 0,
						imapUser: state.imapUser,
						imapPass: text,
					});
					await clearBotState(env, userId);

					// 通知中间件更新连接列表
					if (env.IMAP_BRIDGE_URL && env.IMAP_BRIDGE_SECRET) {
						syncAccounts(env).catch((err) => {
							console.error('Failed to sync with IMAP bridge after account creation:', err);
						});
					}

					const kb = new InlineKeyboard().text('查看账号', `acc:${account.id}`).text('账号列表', 'accs');
					await ctx.reply(
						`✅ IMAP 账号已创建 #${account.id}\n\n邮箱: ${state.imapUser}\nChat ID: ${state.chatId}${state.label ? `\n标签: ${state.label}` : ''}`,
						{ reply_markup: kb },
					);
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
