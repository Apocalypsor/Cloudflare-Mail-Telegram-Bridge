import type { Account, Env } from '@/types';
import { getOwnAccounts } from '@db/accounts';
import { getMappingsByEmailIds, type MessageMapping } from '@db/message-map';
import { getEmailProvider, type EmailListItem, type EmailProvider } from '@services/email/provider';
import { deleteAllJunkEmails, markAllAsRead, syncStarButtonsForMappings } from '@services/message-actions';
import { buildTgMessageLink } from '@services/telegram';
import { buildMailPreviewUrl } from '@utils/hash';
import { escapeMdV2 } from '@utils/markdown-v2';
import { reportErrorToObservability } from '@utils/observability';
import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';

const MAX_PER_ACCOUNT = 20;

/** 生成邮件 web 预览链接 */
async function buildPreviewLink(env: Env, emailId: string, accountId: number): Promise<string | undefined> {
	if (!env.WORKER_URL) return undefined;
	return buildMailPreviewUrl(env.WORKER_URL, env.ADMIN_SECRET, emailId, accountId);
}

interface ListItem {
	subject?: string;
	tgLink?: string;
	previewLink?: string;
}

interface ListResult {
	account: Account;
	items: ListItem[];
	total: number;
	error?: string;
}

/** 查询单个账号的邮件列表，同时生成 TG 深链接和 web 预览链接 */
async function queryAccount(
	env: Env,
	account: Account,
	fetcher: (provider: EmailProvider) => Promise<EmailListItem[]>,
	errorEvent: string,
	afterMappings?: (mappings: MessageMapping[], account: Account) => Promise<void>,
	skipMappingLookup = false,
): Promise<ListResult> {
	try {
		const provider = getEmailProvider(account, env);
		const msgs = await fetcher(provider);
		if (msgs.length === 0) return { account, items: [], total: 0 };

		// message_map 查询（junk 跳过，因为垃圾邮件从未投递到 TG）
		let mappingMap = new Map<string, MessageMapping>();
		if (!skipMappingLookup) {
			const mappings = await getMappingsByEmailIds(
				env.DB,
				account.id,
				msgs.map((m) => m.id),
			);
			if (afterMappings) await afterMappings(mappings, account);
			mappingMap = new Map(mappings.map((m) => [m.email_message_id, m]));
		}

		const items = await Promise.all(
			msgs.map(async (msg) => {
				const mapping = mappingMap.get(msg.id);
				return {
					subject: msg.subject,
					tgLink: mapping ? buildTgMessageLink(mapping.tg_chat_id, mapping.tg_message_id) : undefined,
					previewLink: await buildPreviewLink(env, msg.id, account.id),
				};
			}),
		);

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
	afterMappings?: (mappings: MessageMapping[], account: Account) => Promise<void>,
	skipMappingLookup = false,
): Promise<{ text: string; hasItems: boolean }> {
	const accounts = await getOwnAccounts(env.DB, userId);
	if (accounts.length === 0) return { text: '📭 暂无绑定的邮箱账号', hasItems: false };

	const results = await Promise.all(
		accounts.map((acc) => queryAccount(env, acc, fetcher, config.errorEvent, afterMappings, skipMappingLookup)),
	);

	const lines: string[] = [];
	let total = 0;

	for (const r of results) {
		const accountLabel = escapeMdV2(r.account.email || `Account #${r.account.id}`);
		if (r.error) {
			lines.push(`❌ ${accountLabel}: 查询失败`);
			continue;
		}
		if (r.total === 0) continue;

		total += r.total;
		lines.push(`\n📧 ${accountLabel} \\(${r.total} 封${config.label}\\)`);
		for (const [i, item] of r.items.entries()) {
			const title = escapeMdV2(item.subject || '(无主题)');
			const linkParts: string[] = [];
			if (item.tgLink) linkParts.push(`[💬 消息](${item.tgLink})`);
			if (item.previewLink) linkParts.push(`[👁 预览](${item.previewLink})`);
			const linksStr = linkParts.length > 0 ? `  ${linkParts.join('  ')}` : '';
			lines.push(`  ${i + 1}\\. ${title}${linksStr}`);
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

const junkConfig = {
	icon: '🚫',
	label: '垃圾',
	emptyText: '✅ 没有垃圾邮件',
	errorEvent: 'bot.junk_query_failed',
};

const MARK_ALL_READ_KB = new InlineKeyboard().text('✉️ 标记全部已读', 'mark_all_read');
const DELETE_ALL_JUNK_KB = new InlineKeyboard().text('🗑 全部删除', 'delete_all_junk');

export function registerMailListHandlers(bot: Bot, env: Env) {
	const syncStars = (mappings: MessageMapping[], account: Account) => syncStarButtonsForMappings(env, mappings, account);

	bot.command('unread', async (ctx) => {
		const userId = String(ctx.from?.id);
		const msg = await ctx.reply('🔍 正在查询未读邮件…');
		const { text, hasItems } = await buildListText(env, userId, (p) => p.listUnread(MAX_PER_ACCOUNT), unreadConfig);
		await ctx.api.editMessageText(msg.chat.id, msg.message_id, text, {
			parse_mode: 'MarkdownV2',
			link_preview_options: { is_disabled: true },
			...(hasItems ? { reply_markup: MARK_ALL_READ_KB } : {}),
		});
	});

	bot.callbackQuery('unread', async (ctx) => {
		const userId = String(ctx.from.id);
		await ctx.answerCallbackQuery({ text: '正在查询…' });
		const { text, hasItems } = await buildListText(env, userId, (p) => p.listUnread(MAX_PER_ACCOUNT), unreadConfig);
		await ctx.reply(text, {
			parse_mode: 'MarkdownV2',
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
		const { text } = await buildListText(env, userId, (p) => p.listStarred(MAX_PER_ACCOUNT), starredConfig, syncStars);
		await ctx.api.editMessageText(msg.chat.id, msg.message_id, text, {
			parse_mode: 'MarkdownV2',
			link_preview_options: { is_disabled: true },
		});
	});

	bot.callbackQuery('starred', async (ctx) => {
		const userId = String(ctx.from.id);
		await ctx.answerCallbackQuery({ text: '正在查询…' });
		const { text } = await buildListText(env, userId, (p) => p.listStarred(MAX_PER_ACCOUNT), starredConfig, syncStars);
		await ctx.reply(text, { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } });
	});

	bot.command('junk', async (ctx) => {
		const userId = String(ctx.from?.id);
		const msg = await ctx.reply('🔍 正在查询垃圾邮件…');
		const { text, hasItems } = await buildListText(env, userId, (p) => p.listJunk(MAX_PER_ACCOUNT), junkConfig, undefined, true);
		await ctx.api.editMessageText(msg.chat.id, msg.message_id, text, {
			parse_mode: 'MarkdownV2',
			link_preview_options: { is_disabled: true },
			...(hasItems ? { reply_markup: DELETE_ALL_JUNK_KB } : {}),
		});
	});

	bot.callbackQuery('junk', async (ctx) => {
		const userId = String(ctx.from.id);
		await ctx.answerCallbackQuery({ text: '正在查询…' });
		const { text, hasItems } = await buildListText(env, userId, (p) => p.listJunk(MAX_PER_ACCOUNT), junkConfig, undefined, true);
		await ctx.reply(text, {
			parse_mode: 'MarkdownV2',
			link_preview_options: { is_disabled: true },
			...(hasItems ? { reply_markup: DELETE_ALL_JUNK_KB } : {}),
		});
	});

	bot.callbackQuery('delete_all_junk', async (ctx) => {
		const userId = String(ctx.from.id);
		await ctx.answerCallbackQuery({ text: '正在删除…' });
		const { success, failed } = await deleteAllJunkEmails(env, userId);
		const resultText = failed > 0
			? `🗑 已删除 ${success} 封垃圾邮件，${failed} 个账号失败`
			: `🗑 已删除 ${success} 封垃圾邮件`;
		await ctx.editMessageText(resultText);
	});
}
