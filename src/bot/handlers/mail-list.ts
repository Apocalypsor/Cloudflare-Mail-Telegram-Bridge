import type { Account, Env } from '@/types';
import { getVisibleAccounts } from '@db/accounts';
import { getMappingsByEmailIds, updateStarred } from '@db/message-map';
import { getEmailProvider, type EmailListItem, type EmailProvider } from '@services/email/provider';
import { buildEmailKeyboard } from '@services/keyboard';
import { setReplyMarkup } from '@services/telegram';
import { reportErrorToObservability } from '@utils/observability';
import type { Bot } from 'grammy';

const MAX_PER_ACCOUNT = 20;

/** 生成 Telegram 消息深链接 */
function buildMessageLink(chatId: string, messageId: number): string {
	const numericId = chatId.replace(/^-100/, '');
	return `https://t.me/c/${numericId}/${messageId}`;
}

interface ListResult {
	account: Account;
	items: { subject?: string; link?: string }[];
	total: number;
	error?: string;
}

/** 查询单个账号的邮件列表并匹配 Telegram 消息 */
async function queryAccount(
	env: Env,
	account: Account,
	fetcher: (provider: EmailProvider) => Promise<EmailListItem[]>,
	errorEvent: string,
	syncStarred?: boolean,
): Promise<ListResult> {
	try {
		const provider = getEmailProvider(account, env);
		const msgs = await fetcher(provider);
		if (msgs.length === 0) return { account, items: [], total: 0 };

		const mappings = await getMappingsByEmailIds(
			env.DB,
			account.id,
			msgs.map((m) => m.id),
		);
		const mappingMap = new Map(mappings.map((m) => [m.email_message_id, m]));

		// 同步星标状态：邮件源有星标但本地 message_map 没有的，更新 DB + 按钮
		if (syncStarred) {
			const toSync = mappings.filter((m) => !m.starred);
			if (toSync.length > 0) {
				console.log(`Syncing ${toSync.length} starred messages for account ${account.id}`);
			}
			await Promise.all(
				toSync.map(async (m) => {
					await updateStarred(env.DB, m.tg_chat_id, m.tg_message_id, true);
					try {
						const keyboard = await buildEmailKeyboard(env, m.email_message_id, account.email, m.tg_chat_id, true);
						await setReplyMarkup(env.TELEGRAM_BOT_TOKEN, m.tg_chat_id, m.tg_message_id, keyboard);
					} catch (err) {
						await reportErrorToObservability(env, 'bot.sync_star_button_failed', err, { chatId: m.tg_chat_id, messageId: m.tg_message_id });
					}
				}),
			);
		}

		const items = msgs.map((msg) => {
			const mapping = mappingMap.get(msg.id);
			return {
				subject: msg.subject,
				link: mapping ? buildMessageLink(mapping.tg_chat_id, mapping.tg_message_id) : undefined,
			};
		});

		return { account, items, total: msgs.length };
	} catch (err) {
		await reportErrorToObservability(env, errorEvent, err, { accountId: account.id });
		return { account, items: [], total: 0, error: err instanceof Error ? err.message : String(err) };
	}
}

/** 构建邮件列表结果文本 */
async function buildListText(
	env: Env,
	userId: string,
	admin: boolean,
	fetcher: (provider: EmailProvider) => Promise<EmailListItem[]>,
	config: { icon: string; label: string; emptyText: string; errorEvent: string; syncStarred?: boolean },
): Promise<string> {
	const accounts = await getVisibleAccounts(env.DB, userId, admin);
	if (accounts.length === 0) return '📭 暂无绑定的邮箱账号';

	const results = await Promise.all(accounts.map((acc) => queryAccount(env, acc, fetcher, config.errorEvent, config.syncStarred)));

	const lines: string[] = [];
	let total = 0;

	for (const r of results) {
		const accountLabel = r.account.email || `Account #${r.account.id}`;
		if (r.error) {
			lines.push(`❌ ${accountLabel}: 查询失败`);
			continue;
		}
		if (r.total === 0) continue;

		total += r.total;
		lines.push(`\n📧 ${accountLabel} (${r.total} 封${config.label})`);
		for (const [i, item] of r.items.entries()) {
			const title = item.subject || '(无主题)';
			if (item.link) {
				lines.push(`  ${i + 1}. ${title}\n     ${item.link}`);
			} else {
				lines.push(`  ${i + 1}. ${title}`);
			}
		}
	}

	if (total === 0) return config.emptyText;

	return `${config.icon} 共 ${total} 封${config.label}\n${lines.join('\n')}`;
}

const unreadConfig = {
	icon: '📬',
	label: '未读',
	emptyText: '✅ 所有邮箱都没有未读邮件',
	errorEvent: 'bot.unread_query_failed',
};

const starredConfig = {
	icon: '⭐',
	label: '星标',
	emptyText: '✅ 没有星标邮件',
	errorEvent: 'bot.starred_query_failed',
	syncStarred: true,
};

export function registerMailListHandlers(bot: Bot, env: Env) {
	bot.command('unread', async (ctx) => {
		const userId = String(ctx.from?.id);
		const msg = await ctx.reply('🔍 正在查询未读邮件…');
		const text = await buildListText(env, userId, false, (p) => p.listUnread(MAX_PER_ACCOUNT), unreadConfig);
		await ctx.api.editMessageText(msg.chat.id, msg.message_id, text, { link_preview_options: { is_disabled: true } });
	});

	bot.callbackQuery('unread', async (ctx) => {
		const userId = String(ctx.from.id);
		await ctx.answerCallbackQuery({ text: '正在查询…' });
		const text = await buildListText(env, userId, false, (p) => p.listUnread(MAX_PER_ACCOUNT), unreadConfig);
		await ctx.reply(text, { link_preview_options: { is_disabled: true } });
	});

	bot.command('starred', async (ctx) => {
		const userId = String(ctx.from?.id);
		const msg = await ctx.reply('🔍 正在查询星标邮件…');
		const text = await buildListText(env, userId, false, (p) => p.listStarred(MAX_PER_ACCOUNT), starredConfig);
		await ctx.api.editMessageText(msg.chat.id, msg.message_id, text, { link_preview_options: { is_disabled: true } });
	});

	bot.callbackQuery('starred', async (ctx) => {
		const userId = String(ctx.from.id);
		await ctx.answerCallbackQuery({ text: '正在查询…' });
		const text = await buildListText(env, userId, false, (p) => p.listStarred(MAX_PER_ACCOUNT), starredConfig);
		await ctx.reply(text, { link_preview_options: { is_disabled: true } });
	});
}
