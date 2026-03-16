import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { KV_OAUTH_BOT_MSG_PREFIX, OAUTH_STATE_TTL_SECONDS } from '@/constants';
import {
	createAccount,
	getAllAccounts,
	getAuthorizedAccount,
	getOwnAccounts,
	getVisibleAccounts,
	updateAccount,
} from '@db/accounts';
import { getAllUsers, getUserByTelegramId } from '@db/users';
import { cleanupAndDeleteAccount } from '@services/account';
import { renewWatch } from '@services/email/gmail';
import { generateOAuthUrl } from '@services/email/gmail/oauth';
import { renewSubscription } from '@services/email/outlook';
import { generateOAuthUrl as generateMsOAuthUrl } from '@services/email/outlook/oauth';
import { reportErrorToObservability } from '@utils/observability';
import type { Account, Env } from '@/types';
import { AccountType } from '@/types';
import { isAdmin } from '@bot/auth';
import { accountDetailKeyboard, accountDetailText, formatUserName } from '@bot/formatters';
import { clearBotState, getBotState, setBotState } from '@bot/state';

async function resolveAccount(env: Env, fromId: number, accountIdStr: string) {
	const userId = String(fromId);
	const accountId = parseInt(accountIdStr, 10);
	const admin = isAdmin(userId, env);
	const account = await getAuthorizedAccount(env.DB, accountId, userId, admin);
	return { userId, accountId, admin, account };
}

export function accountListKeyboard(accounts: Account[], options?: { isAdmin?: boolean; showAll?: boolean; showBack?: boolean }): InlineKeyboard {
	const kb = new InlineKeyboard();
	for (const acc of accounts) {
		const status = acc.type === AccountType.Imap ? '📬' : acc.refresh_token ? '✅' : '❌';
		const display = acc.email || `#${acc.id}`;
		kb.text(`${status} ${display}`, `acc:${acc.id}`).row();
	}
	kb.text('➕ 添加账号', 'add').row();
	if (options?.isAdmin) {
		const back = options.showBack ? '' : ':s';
		kb.text(options.showAll ? '🔽 收起' : '👀 查看所有账号', options.showAll ? `accs${back}` : `accs:all${back}`).row();
	}
	if (options?.showBack) kb.text('« 返回', 'menu');
	return kb;
}

export function registerAccountHandlers(bot: Bot, env: Env) {
	// Account list (default: own accounts only)
	bot.callbackQuery('accs', async (ctx) => {
		const userId = String(ctx.from.id);
		await clearBotState(env, userId);
		const admin = isAdmin(userId, env);
		const accounts = admin ? await getOwnAccounts(env.DB, userId) : await getVisibleAccounts(env.DB, userId, false);

		const text = accounts.length > 0 ? `📧 我的账号 (${accounts.length})` : '📧 暂无账号';
		await ctx.editMessageText(text, { reply_markup: accountListKeyboard(accounts, { isAdmin: admin, showBack: true }) });
		await ctx.answerCallbackQuery();
	});

	// Account list (admin: show all accounts, from menu)
	bot.callbackQuery('accs:all', async (ctx) => {
		const userId = String(ctx.from.id);
		await clearBotState(env, userId);
		if (!isAdmin(userId, env)) return ctx.answerCallbackQuery({ text: '无权操作' });

		const accounts = await getAllAccounts(env.DB);
		const text = `📧 所有账号 (${accounts.length})`;
		await ctx.editMessageText(text, { reply_markup: accountListKeyboard(accounts, { isAdmin: true, showAll: true, showBack: true }) });
		await ctx.answerCallbackQuery();
	});

	// Account list (admin: show all accounts, standalone from /accounts)
	bot.callbackQuery('accs:all:s', async (ctx) => {
		const userId = String(ctx.from.id);
		await clearBotState(env, userId);
		if (!isAdmin(userId, env)) return ctx.answerCallbackQuery({ text: '无权操作' });

		const accounts = await getAllAccounts(env.DB);
		const text = `📧 所有账号 (${accounts.length})`;
		await ctx.editMessageText(text, { reply_markup: accountListKeyboard(accounts, { isAdmin: true, showAll: true }) });
		await ctx.answerCallbackQuery();
	});

	// Account list (standalone: collapse back to own accounts)
	bot.callbackQuery('accs:s', async (ctx) => {
		const userId = String(ctx.from.id);
		await clearBotState(env, userId);
		const accounts = await getOwnAccounts(env.DB, userId);

		const text = accounts.length > 0 ? `📧 我的账号 (${accounts.length})` : '📧 暂无账号';
		await ctx.editMessageText(text, { reply_markup: accountListKeyboard(accounts, { isAdmin: true }) });
		await ctx.answerCallbackQuery();
	});

	// Account detail
	bot.callbackQuery(/^acc:(\d+)$/, async (ctx) => {
		const { userId, admin, account } = await resolveAccount(env, ctx.from.id, ctx.match![1]);
		await clearBotState(env, userId);
		if (!account) return ctx.answerCallbackQuery({ text: '账号不存在或无权访问' });

		let ownerName: string | undefined;
		if (admin && account.telegram_user_id) {
			const owner = await getUserByTelegramId(env.DB, account.telegram_user_id);
			ownerName = owner?.username ? `@${owner.username}` : formatUserName(owner ?? { first_name: account.telegram_user_id });
		} else if (admin) {
			ownerName = '';
		}
		await ctx.editMessageText(accountDetailText(account, ownerName), { reply_markup: accountDetailKeyboard(account) });
		await ctx.answerCallbackQuery();
	});

	// OAuth authorization (Gmail / Outlook)
	bot.callbackQuery(/^acc:(\d+):auth$/, async (ctx) => {
		const { accountId, account } = await resolveAccount(env, ctx.from.id, ctx.match![1]);
		if (!account) return ctx.answerCallbackQuery({ text: '账号不存在或无权访问' });
		if (account.type === AccountType.Imap) return ctx.answerCallbackQuery({ text: 'IMAP 账号不需要 OAuth 授权' });

		try {
			const origin = env.WORKER_URL?.replace(/\/$/, '') || '';
			const isOutlook = account.type === AccountType.Outlook;
			const oauthUrl = isOutlook ? await generateMsOAuthUrl(env, accountId, origin) : await generateOAuthUrl(env, accountId, origin);
			const providerName = isOutlook ? 'Microsoft' : 'Google';

			const kb = new InlineKeyboard().url('🔗 点击授权', oauthUrl).row().text('« 返回', `acc:${accountId}`);
			await ctx.editMessageText(
				`🔑 ${providerName} OAuth 授权\n\n账号: ${account.email || `#${account.id}`}\n\n请点击下方按钮完成 ${providerName} 授权：`,
				{ reply_markup: kb },
			);

			const msg = ctx.callbackQuery.message;
			if (msg) {
				await env.EMAIL_KV.put(
					`${KV_OAUTH_BOT_MSG_PREFIX}${accountId}`,
					JSON.stringify({ chatId: String(msg.chat.id), messageId: msg.message_id }),
					{
						expirationTtl: OAUTH_STATE_TTL_SECONDS,
					},
				);
			}
		} catch (err) {
			await reportErrorToObservability(env, 'bot.oauth_url_gen_failed', err);
			return ctx.answerCallbackQuery({ text: '生成授权链接失败' });
		}
		await ctx.answerCallbackQuery();
	});

	// Renew watch / subscription (Gmail / Outlook)
	bot.callbackQuery(/^acc:(\d+):w$/, async (ctx) => {
		const { account } = await resolveAccount(env, ctx.from.id, ctx.match![1]);
		if (!account) return ctx.answerCallbackQuery({ text: '账号不存在或无权访问' });
		if (!account.refresh_token) return ctx.answerCallbackQuery({ text: '账号未授权' });

		try {
			if (account.type === AccountType.Outlook) {
				await renewSubscription(env, account);
			} else {
				await renewWatch(env, account);
			}
			await ctx.answerCallbackQuery({ text: `✅ Watch 已续订: ${account.email}` });
		} catch (err) {
			await reportErrorToObservability(env, 'bot.watch_renew_failed', err);
			await ctx.answerCallbackQuery({ text: '❌ Watch 续订失败' });
		}
	});

	// Delete confirmation prompt
	bot.callbackQuery(/^acc:(\d+):del$/, async (ctx) => {
		const { accountId, account } = await resolveAccount(env, ctx.from.id, ctx.match![1]);
		if (!account) return ctx.answerCallbackQuery({ text: '账号不存在或无权访问' });

		const kb = new InlineKeyboard().text('⚠️ 确认删除', `acc:${accountId}:dy`).text('取消', `acc:${accountId}`);
		await ctx.editMessageText(
			`⚠️ 确认删除账号 #${accountId}?\n\n邮箱: ${account.email || '(未设置)'}\nChat ID: ${account.chat_id}\n\n此操作不可撤销。`,
			{ reply_markup: kb },
		);
		await ctx.answerCallbackQuery();
	});

	// Confirm delete
	bot.callbackQuery(/^acc:(\d+):dy$/, async (ctx) => {
		const { userId, accountId, admin, account } = await resolveAccount(env, ctx.from.id, ctx.match![1]);
		if (!account) return ctx.answerCallbackQuery({ text: '账号不存在或无权访问' });

		await cleanupAndDeleteAccount(env, account);

		const accounts = admin ? await getOwnAccounts(env.DB, userId) : await getVisibleAccounts(env.DB, userId, false);
		await ctx.editMessageText(`✅ 账号 #${accountId} 已删除\n\n📧 我的账号 (${accounts.length})`, {
			reply_markup: accountListKeyboard(accounts, { isAdmin: admin, showBack: true }),
		});
		await ctx.answerCallbackQuery({ text: '✅ 已删除' });
	});

	// Edit menu
	bot.callbackQuery(/^acc:(\d+):edit$/, async (ctx) => {
		const { userId, accountId, admin, account } = await resolveAccount(env, ctx.from.id, ctx.match![1]);
		await clearBotState(env, userId);
		if (!account) return ctx.answerCallbackQuery({ text: '账号不存在或无权访问' });

		const kb = new InlineKeyboard().text('✏️ 编辑 Chat ID', `acc:${accountId}:eci`).row();
		if (admin) {
			kb.text('👤 分配所有者', `acc:${accountId}:own`).row();
		}
		kb.text('« 返回', `acc:${accountId}`);

		await ctx.editMessageText(`✏️ 编辑账号 #${accountId}\n\n${accountDetailText(account)}\n\n选择要编辑的项目：`, { reply_markup: kb });
		await ctx.answerCallbackQuery();
	});

	// Edit Chat ID
	bot.callbackQuery(/^acc:(\d+):eci$/, async (ctx) => {
		const { userId, accountId, account } = await resolveAccount(env, ctx.from.id, ctx.match![1]);
		if (!account) return ctx.answerCallbackQuery({ text: '账号不存在或无权访问' });

		await setBotState(env, userId, { action: 'edit_chatid', accountId });
		const kb = new InlineKeyboard().text('❌ 取消', `acc:${accountId}:edit`);
		await ctx.editMessageText(`✏️ 编辑 Chat ID\n\n当前值: ${account.chat_id}\n\n请发送新的 Chat ID：`, { reply_markup: kb });
		await ctx.answerCallbackQuery();
	});

	// Owner selection (admin)
	bot.callbackQuery(/^acc:(\d+):own$/, async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) return ctx.answerCallbackQuery({ text: '无权操作' });

		const accountId = parseInt(ctx.match![1], 10);
		const account = await getAuthorizedAccount(env.DB, accountId, userId, true);
		if (!account) return ctx.answerCallbackQuery({ text: '账号不存在' });

		const users = await getAllUsers(env.DB);
		const kb = new InlineKeyboard();
		for (const u of users) {
			const name = formatUserName(u);
			const current = u.telegram_id === account.telegram_user_id ? ' (当前)' : '';
			kb.text(`${name}${current}`, `edown:${accountId}:${u.telegram_id}`).row();
		}
		kb.text('« 返回', `acc:${accountId}:edit`);

		await ctx.editMessageText(
			`👤 分配所有者\n\n账号 #${accountId}\n当前所有者: ${account.telegram_user_id || '(无)'}\n\n选择新的所有者：`,
			{
				reply_markup: kb,
			},
		);
		await ctx.answerCallbackQuery();
	});

	// Confirm owner change
	bot.callbackQuery(/^edown:(\d+):(\d+)$/, async (ctx) => {
		const userId = String(ctx.from.id);
		if (!isAdmin(userId, env)) return ctx.answerCallbackQuery({ text: '无权操作' });

		const accountId = parseInt(ctx.match![1], 10);
		const newOwner = ctx.match![2];
		const account = await getAuthorizedAccount(env.DB, accountId, userId, true);
		if (!account) return ctx.answerCallbackQuery({ text: '账号不存在' });

		await updateAccount(env.DB, accountId, account.chat_id, newOwner);
		const updated = await getAuthorizedAccount(env.DB, accountId, userId, true);
		if (!updated) return ctx.answerCallbackQuery({ text: '账号不存在' });
		const newOwnerUser = await getUserByTelegramId(env.DB, newOwner);
		const ownerName = newOwnerUser?.username ? `@${newOwnerUser.username}` : formatUserName(newOwnerUser ?? { first_name: newOwner });
		await ctx.editMessageText(accountDetailText(updated, ownerName), { reply_markup: accountDetailKeyboard(updated) });
		await ctx.answerCallbackQuery({ text: `✅ 已分配给 ${newOwner}` });
	});

	// Start add flow
	bot.callbackQuery('add', async (ctx) => {
		const userId = String(ctx.from.id);
		await setBotState(env, userId, { action: 'add', step: 'chat_id' });

		const kb = new InlineKeyboard().text(`📌 使用当前 Chat ID (${userId})`, `addme`).row().text('❌ 取消', 'accs');
		await ctx.editMessageText('➕ 添加账号\n\n请发送 Chat ID（数字），或点击下方按钮使用当前会话 ID：', { reply_markup: kb });
		await ctx.answerCallbackQuery();
	});

	// Add with own chat ID shortcut
	bot.callbackQuery('addme', async (ctx) => {
		const userId = String(ctx.from.id);
		await setBotState(env, userId, { action: 'add', step: 'type', chatId: userId });

		const kb = new InlineKeyboard()
			.text('📨 Gmail (OAuth)', 'addtype:gmail')
			.row()
			.text('📮 Outlook (OAuth)', 'addtype:outlook')
			.row()
			.text('📬 IMAP', 'addtype:imap')
			.row()
			.text('❌ 取消', 'accs');
		await ctx.editMessageText(`➕ 添加账号\n\nChat ID: ${userId}\n\n选择账号类型：`, { reply_markup: kb });
		await ctx.answerCallbackQuery();
	});

	// Type selection: Gmail
	bot.callbackQuery('addtype:gmail', async (ctx) => {
		const userId = String(ctx.from.id);
		const state = await getBotState(env, userId);
		if (!state || state.action !== 'add' || state.step !== 'type') {
			return ctx.answerCallbackQuery({ text: '操作已过期' });
		}

		try {
			const account = await createAccount(env.DB, state.chatId, userId);
			await clearBotState(env, userId);

			const kb = new InlineKeyboard().text('查看账号', `acc:${account.id}`).text('账号列表', 'accs');
			await ctx.editMessageText(
				`✅ Gmail 账号已创建 #${account.id}\n\nChat ID: ${state.chatId}\n\n请点击「查看账号」完成 Google OAuth 授权。`,
				{ reply_markup: kb },
			);
		} catch (err) {
			await clearBotState(env, userId);
			await reportErrorToObservability(env, 'bot.create_account_failed', err);
			await ctx.editMessageText('❌ 创建失败，请稍后重试');
		}
		await ctx.answerCallbackQuery();
	});

	// Type selection: Outlook
	bot.callbackQuery('addtype:outlook', async (ctx) => {
		const userId = String(ctx.from.id);
		const state = await getBotState(env, userId);
		if (!state || state.action !== 'add' || state.step !== 'type') {
			return ctx.answerCallbackQuery({ text: '操作已过期' });
		}

		if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) {
			return ctx.answerCallbackQuery({ text: '❌ Microsoft OAuth 未配置，请联系管理员' });
		}

		try {
			const account = await createAccount(env.DB, state.chatId, userId, AccountType.Outlook);
			await clearBotState(env, userId);

			const kb = new InlineKeyboard().text('查看账号', `acc:${account.id}`).text('账号列表', 'accs');
			await ctx.editMessageText(
				`✅ Outlook 账号已创建 #${account.id}\n\nChat ID: ${state.chatId}\n\n请点击「查看账号」完成 Microsoft OAuth 授权。`,
				{ reply_markup: kb },
			);
		} catch (err) {
			await clearBotState(env, userId);
			await reportErrorToObservability(env, 'bot.create_account_failed', err);
			await ctx.editMessageText('❌ 创建失败，请稍后重试');
		}
		await ctx.answerCallbackQuery();
	});

	// Type selection: IMAP
	bot.callbackQuery('addtype:imap', async (ctx) => {
		const userId = String(ctx.from.id);
		const state = await getBotState(env, userId);
		if (!state || state.action !== 'add' || state.step !== 'type') {
			return ctx.answerCallbackQuery({ text: '操作已过期' });
		}

		if (!env.IMAP_BRIDGE_URL || !env.IMAP_BRIDGE_SECRET) {
			return ctx.answerCallbackQuery({ text: '❌ IMAP 中间件未配置，请联系管理员' });
		}

		await setBotState(env, userId, { action: 'add_imap', step: 'host', chatId: state.chatId });
		const kb = new InlineKeyboard().text('❌ 取消', 'accs');
		await ctx.editMessageText(`📬 添加 IMAP 账号\n\nChat ID: ${state.chatId}\n\n请发送 IMAP 服务器地址（如 imap.gmail.com）：`, {
			reply_markup: kb,
		});
		await ctx.answerCallbackQuery();
	});

	// IMAP: secure selection (Yes/No inline buttons)
	bot.callbackQuery(/^imapsecure:(yes|no)$/, async (ctx) => {
		const userId = String(ctx.from.id);
		const state = await getBotState(env, userId);
		if (!state || state.action !== 'add_imap' || state.step !== 'secure') {
			return ctx.answerCallbackQuery({ text: '操作已过期' });
		}

		const secure = ctx.match![1] === 'yes';
		await setBotState(env, userId, { ...state, step: 'user', imapSecure: secure });
		const kb = new InlineKeyboard().text('❌ 取消', 'accs');
		await ctx.editMessageText(
			`📬 添加 IMAP 账号\n\n服务器: ${state.imapHost}:${state.imapPort} ${secure ? '(TLS)' : '(无 TLS)'}\n\n请发送 IMAP 用户名（通常为邮箱地址）：`,
			{ reply_markup: kb },
		);
		await ctx.answerCallbackQuery();
	});
}
