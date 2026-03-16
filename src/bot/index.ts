import { BOT_INFO_TTL, KV_BOT_COMMANDS_VERSION_KEY, KV_BOT_INFO_KEY } from '@/constants';
import type { Env } from '@/types';
import { isAdmin } from '@bot/auth';
import { formatUserName, userListText } from '@bot/formatters';
import { accountListKeyboard, registerAccountHandlers } from '@bot/handlers/accounts';
import { registerAdminHandlers } from '@bot/handlers/admin';
import { registerInputHandler } from '@bot/handlers/input';
import { registerReactionHandler } from '@bot/handlers/reaction';
import { registerStarHandler } from '@bot/handlers/star';
import { registerUnreadHandler } from '@bot/handlers/unread';
import { getOwnAccounts, getVisibleAccounts } from '@db/accounts';
import { approveUser, getNonAdminUsers, getUserByTelegramId, rejectUser, upsertUser } from '@db/users';
import { reportErrorToObservability } from '@utils/observability';
import { Api, Bot, InlineKeyboard } from 'grammy';
import type { BotCommand, UserFromGetMe } from 'grammy/types';

export { STAR_KEYBOARD, starKeyboardWithMailUrl, STARRED_KEYBOARD, starredKeyboardWithMailUrl } from '@bot/keyboards';

// ─── Bot 命令定义 ───────────────────────────────────────────────────────────
// 修改此列表后更新 BOT_COMMANDS_VERSION，会自动同步到 Telegram
const BOT_COMMANDS_VERSION = 2;

const BOT_COMMANDS: BotCommand[] = [
	{ command: 'start', description: '打开管理面板' },
	{ command: 'help', description: '查看帮助信息' },
	{ command: 'accounts', description: '查看我的邮箱账号' },
	{ command: 'unread', description: '查看未读邮件' },
	{ command: 'users', description: '查看用户列表（管理员）' },
];

const HELP_TEXT = `📬 *Telemail 帮助*

*命令列表*
/start \\- 打开管理面板
/help \\- 查看帮助信息
/accounts \\- 查看我的邮箱账号
/unread \\- 查看未读邮件
/users \\- 查看用户列表（管理员）

*功能说明*
• 支持 Gmail / Outlook / IMAP 邮箱转发到 Telegram
• 点击 ⭐ 按钮可星标/取消星标邮件
• 对消息添加 emoji reaction 可标记邮件为已读
• 发送 /unread 查看未读邮件列表并跳转
• 配置 LLM 后自动生成 AI 摘要`;

/**
 * 同步 Bot 命令菜单到 Telegram。
 * 使用 KV 存储版本号，仅在 BOT_COMMANDS_VERSION 变化时调用 setMyCommands。
 */
export async function syncBotCommands(env: Env): Promise<void> {
	const cached = await env.EMAIL_KV.get(KV_BOT_COMMANDS_VERSION_KEY);
	if (cached === String(BOT_COMMANDS_VERSION)) return;

	const api = new Api(env.TELEGRAM_BOT_TOKEN);
	await api.setMyCommands(BOT_COMMANDS);
	await env.EMAIL_KV.put(KV_BOT_COMMANDS_VERSION_KEY, String(BOT_COMMANDS_VERSION));
}

/** 从 KV 获取 botInfo，首次调用时从 Telegram API 拉取并缓存 */
export async function getBotInfo(env: Env): Promise<UserFromGetMe> {
	const cached = await env.EMAIL_KV.get(KV_BOT_INFO_KEY);
	if (cached) return JSON.parse(cached);

	const api = new Api(env.TELEGRAM_BOT_TOKEN);
	const botInfo = await api.getMe();
	await env.EMAIL_KV.put(KV_BOT_INFO_KEY, JSON.stringify(botInfo), { expirationTtl: BOT_INFO_TTL });
	return botInfo;
}

function mainMenuKeyboard(admin: boolean): InlineKeyboard {
	const kb = new InlineKeyboard().text('📧 账号管理', 'accs').text('📬 未读邮件', 'unread').row();
	if (admin) {
		kb.text('👥 用户管理', 'users').text('⚙️ 全局操作', 'admin').row();
	}
	return kb;
}

/** 创建 grammY Bot 实例（仅用于 webhook 接收端） */
export function createBot(env: Env, botInfo: UserFromGetMe) {
	const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });

	bot.catch(async (err) => {
		await reportErrorToObservability(env, 'bot.handler_error', err.error).catch(() => {});
		// 尝试通知用户操作失败
		try {
			if (err.ctx.callbackQuery) {
				await err.ctx.answerCallbackQuery({ text: '❌ 操作失败，请重试' }).catch(() => {});
			}
		} catch {
			// ignore
		}
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
					const kb = new InlineKeyboard().text('✅ 批准', `approve:${telegramId}`).text('❌ 拒绝', `reject:${telegramId}`);
					await ctx.api.sendMessage(env.ADMIN_TELEGRAM_ID, `🆕 新用户注册: ${displayName}${username}\nTelegram ID: ${telegramId}`, {
						reply_markup: kb,
					});
				} catch (err) {
					await reportErrorToObservability(env, 'bot.notify_admin_failed', err);
				}
			}
		}

		// 未审批用户
		if (!admin && user && user.approved !== 1) {
			return ctx.reply('您的账号正在等待管理员审批，审批通过后会收到通知。');
		}

		return ctx.reply('📬 Telemail 管理面板', { reply_markup: mainMenuKeyboard(admin) });
	});

	// ─── /help: 帮助信息 ────────────────────────────────────────────────────
	bot.command('help', async (ctx) => {
		return ctx.reply(HELP_TEXT, { parse_mode: 'MarkdownV2' });
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

		const accounts = admin ? await getOwnAccounts(env.DB, userId) : await getVisibleAccounts(env.DB, userId, false);
		const text = accounts.length > 0 ? `📧 我的账号 (${accounts.length})` : '📧 暂无账号';
		return ctx.reply(text, { reply_markup: accountListKeyboard(accounts, { isAdmin: admin }) });
	});

	// ─── /users: 快速查看用户列表（管理员） ──────────────────────────────────
	bot.command('users', async (ctx) => {
		const userId = String(ctx.from?.id);
		if (!isAdmin(userId, env)) {
			return ctx.reply('⛔ 仅管理员可用');
		}

		const users = await getNonAdminUsers(env.DB, env.ADMIN_TELEGRAM_ID);
		return ctx.reply(userListText(users));
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
	registerUnreadHandler(bot, env);
	// 输入处理必须最后注册（catch-all text handler）
	registerInputHandler(bot, env);

	return bot;
}
