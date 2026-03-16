import type { Account, Env } from '@/types';
import { buildEmailKeyboard } from '@bot/keyboards';
import { getOwnAccounts } from '@db/accounts';
import { getMappingsByEmailIds } from '@db/message-map';
import { getEmailProvider, type EmailListItem, type EmailProvider } from '@services/email/provider';
import { markAllAsRead } from '@services/message-actions';
import { setReplyMarkup } from '@services/telegram';
import { reportErrorToObservability } from '@utils/observability';
import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';

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
	fetcher: (provider: EmailProvider) => Promise<EmailListItem[]>,
	config: { icon: string; label: string; emptyText: string; errorEvent: string },
): Promise<{ text: string; hasItems: boolean }> {
	const accounts = await getOwnAccounts(env.DB, userId);
	if (accounts.length === 0) return { text: '📭 暂无绑定的邮箱账号', hasItems: false };

	const results = await Promise.all(accounts.map((acc) => queryAccount(env, acc, fetcher, config.errorEvent)));

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

	if (total === 0) return { text: config.emptyText, hasItems: false };

	return { text: `${config.icon} 共 ${total} 封${config.label}\n${lines.join('\n')}`, hasItems: true };
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
};

/** 查询星标邮件并同步 Telegram 消息的星标按钮状态 */
async function buildStarredListText(env: Env, userId: string): Promise<{ text: string; hasItems: boolean }> {
	const accounts = await getOwnAccounts(env.DB, userId);
	if (accounts.length === 0) return { text: '📭 暂无绑定的邮箱账号', hasItems: false };

	const results = await Promise.all(
		accounts.map(async (account) => {
			try {
				const provider = getEmailProvider(account, env);
				const msgs = await provider.listStarred(MAX_PER_ACCOUNT);
				if (msgs.length === 0) return { account, items: [] as { subject?: string; link?: string }[], total: 0 };

				const mappings = await getMappingsByEmailIds(
					env.DB,
					account.id,
					msgs.map((m) => m.id),
				);
				const mappingMap = new Map(mappings.map((m) => [m.email_message_id, m]));

				// 同步星标按钮状态
				await Promise.all(
					mappings.map(async (m) => {
						try {
							const keyboard = await buildEmailKeyboard(env, m.email_message_id, account.email, m.tg_chat_id, true);
							await setReplyMarkup(env.TELEGRAM_BOT_TOKEN, m.tg_chat_id, m.tg_message_id, keyboard);
						} catch (err) {
							if (err instanceof Error && err.message.includes('message is not modified')) return;
							await reportErrorToObservability(env, 'bot.sync_star_button_failed', err, {
								chatId: m.tg_chat_id,
								messageId: m.tg_message_id,
							});
						}
					}),
				);

				const items = msgs.map((msg) => {
					const mapping = mappingMap.get(msg.id);
					return {
						subject: msg.subject,
						link: mapping ? buildMessageLink(mapping.tg_chat_id, mapping.tg_message_id) : undefined,
					};
				});

				return { account, items, total: msgs.length };
			} catch (err) {
				await reportErrorToObservability(env, starredConfig.errorEvent, err, { accountId: account.id });
				return {
					account,
					items: [] as { subject?: string; link?: string }[],
					total: 0,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}),
	);

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
		lines.push(`\n📧 ${accountLabel} (${r.total} 封星标)`);
		for (const [i, item] of r.items.entries()) {
			const title = item.subject || '(无主题)';
			if (item.link) {
				lines.push(`  ${i + 1}. ${title}\n     ${item.link}`);
			} else {
				lines.push(`  ${i + 1}. ${title}`);
			}
		}
	}

	if (total === 0) return { text: starredConfig.emptyText, hasItems: false };
	return { text: `⭐ 共 ${total} 封星标\n${lines.join('\n')}`, hasItems: true };
}

const MARK_ALL_READ_KB = new InlineKeyboard().text('✉️ 标记全部已读', 'mark_all_read');

export function registerMailListHandlers(bot: Bot, env: Env) {
	bot.command('unread', async (ctx) => {
		const userId = String(ctx.from?.id);
		const msg = await ctx.reply('🔍 正在查询未读邮件…');
		const { text, hasItems } = await buildListText(env, userId, (p) => p.listUnread(MAX_PER_ACCOUNT), unreadConfig);
		await ctx.api.editMessageText(msg.chat.id, msg.message_id, text, {
			link_preview_options: { is_disabled: true },
			...(hasItems ? { reply_markup: MARK_ALL_READ_KB } : {}),
		});
	});

	bot.callbackQuery('unread', async (ctx) => {
		const userId = String(ctx.from.id);
		await ctx.answerCallbackQuery({ text: '正在查询…' });
		const { text, hasItems } = await buildListText(env, userId, (p) => p.listUnread(MAX_PER_ACCOUNT), unreadConfig);
		await ctx.reply(text, {
			link_preview_options: { is_disabled: true },
			...(hasItems ? { reply_markup: MARK_ALL_READ_KB } : {}),
		});
	});

	bot.callbackQuery('mark_all_read', async (ctx) => {
		const userId = String(ctx.from.id);
		await ctx.answerCallbackQuery({ text: '正在标记…' });

		const { success, failed } = await markAllAsRead(env, userId);
		const resultText = failed > 0 ? `✅ 已标记 ${success} 封已读，${failed} 封失败` : `✅ 已标记 ${success} 封已读`;

		await ctx.editMessageText(resultText);
	});

	bot.command('starred', async (ctx) => {
		const userId = String(ctx.from?.id);
		const msg = await ctx.reply('🔍 正在查询星标邮件…');
		const { text } = await buildStarredListText(env, userId);
		await ctx.api.editMessageText(msg.chat.id, msg.message_id, text, { link_preview_options: { is_disabled: true } });
	});

	bot.callbackQuery('starred', async (ctx) => {
		const userId = String(ctx.from.id);
		await ctx.answerCallbackQuery({ text: '正在查询…' });
		const { text } = await buildStarredListText(env, userId);
		await ctx.reply(text, { link_preview_options: { is_disabled: true } });
	});
}
