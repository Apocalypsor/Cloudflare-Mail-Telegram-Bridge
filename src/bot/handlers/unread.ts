import type { Bot } from 'grammy';
import { getVisibleAccounts } from '@db/accounts';
import { getMappingsByEmailIds } from '@db/message-map';
import { getEmailProvider } from '@services/email/provider';
import { reportErrorToObservability } from '@utils/observability';
import type { Account, Env } from '@/types';
import { isAdmin } from '@bot/auth';

const MAX_UNREAD_PER_ACCOUNT = 20;

/** 生成 Telegram 消息深链接 */
function buildMessageLink(chatId: string, messageId: number): string {
	// 私聊/群组: chat_id 为负数，去掉 -100 前缀
	const numericId = chatId.replace(/^-100/, '');
	return `https://t.me/c/${numericId}/${messageId}`;
}

/** 查询单个账号的未读邮件并匹配 Telegram 消息 */
async function getUnreadForAccount(
	env: Env,
	account: Account,
): Promise<{ account: Account; links: string[]; total: number; error?: string }> {
	try {
		const provider = getEmailProvider(account, env);
		const unreadIds = await provider.listUnread(MAX_UNREAD_PER_ACCOUNT);
		if (unreadIds.length === 0) return { account, links: [], total: 0 };

		const mappings = await getMappingsByEmailIds(env.DB, account.id, unreadIds);
		const links = mappings.map((m) => buildMessageLink(m.tg_chat_id, m.tg_message_id));

		return { account, links, total: unreadIds.length };
	} catch (err) {
		await reportErrorToObservability(env, 'bot.unread_query_failed', err, { accountId: account.id });
		return { account, links: [], total: 0, error: err instanceof Error ? err.message : String(err) };
	}
}

/** 构建未读邮件结果文本 */
async function buildUnreadText(env: Env, userId: string, admin: boolean): Promise<string> {
	const accounts = await getVisibleAccounts(env.DB, userId, admin);

	if (accounts.length === 0) return '📭 暂无绑定的邮箱账号';

	const results = await Promise.all(accounts.map((acc) => getUnreadForAccount(env, acc)));

	const lines: string[] = [];
	let totalUnread = 0;

	for (const r of results) {
		const label = r.account.email || `Account #${r.account.id}`;
		if (r.error) {
			lines.push(`❌ ${label}: 查询失败`);
			continue;
		}
		if (r.total === 0) continue;

		totalUnread += r.total;
		lines.push(`\n📧 ${label} (${r.total} 封未读)`);
		if (r.links.length > 0) {
			r.links.forEach((link, i) => lines.push(`  ${i + 1}. ${link}`));
		}
		const unmapped = r.total - r.links.length;
		if (unmapped > 0) {
			lines.push(`  … 另有 ${unmapped} 封未在 Telegram 中找到`);
		}
	}

	if (totalUnread === 0) return '✅ 所有邮箱都没有未读邮件';

	return `📬 共 ${totalUnread} 封未读邮件\n${lines.join('\n')}`;
}

export function registerUnreadHandler(bot: Bot, env: Env) {
	bot.command('unread', async (ctx) => {
		const userId = String(ctx.from?.id);
		const admin = isAdmin(userId, env);

		await ctx.reply('🔍 正在查询未读邮件…');
		const text = await buildUnreadText(env, userId, admin);
		return ctx.reply(text, { link_preview_options: { is_disabled: true } });
	});

	bot.callbackQuery('unread', async (ctx) => {
		const userId = String(ctx.from.id);
		const admin = isAdmin(userId, env);

		await ctx.answerCallbackQuery({ text: '正在查询…' });
		const text = await buildUnreadText(env, userId, admin);
		await ctx.editMessageText(text, { link_preview_options: { is_disabled: true } });
	});
}
