import { InlineKeyboard } from 'grammy';
import { getAccountById, getOwnAccounts } from '@db/accounts';
import { getMessageMapping, type MessageMapping } from '@db/message-map';
import type { Account, Env } from '@/types';
import { getEmailProvider } from '@services/email/provider';
import { buildEmailKeyboard } from '@bot/keyboards';
import { setReplyMarkup } from '@services/telegram';
import { reportErrorToObservability } from '@utils/observability';

type ToggleStarResult = { ok: true; keyboard: InlineKeyboard; emailMessageId: string } | { ok: false; reason: string };

/** 切换星标并返回新的 keyboard */
export async function toggleStar(env: Env, chatId: string, messageId: number, starred: boolean): Promise<ToggleStarResult> {
	const mapping = await getMessageMapping(env.DB, chatId, messageId);
	if (!mapping) return { ok: false, reason: '消息映射未找到' };

	const account = await getAccountById(env.DB, mapping.account_id);
	if (!account) return { ok: false, reason: '账号未找到' };

	const provider = getEmailProvider(account, env);
	if (starred) {
		await provider.addStar(mapping.email_message_id);
	} else {
		await provider.removeStar(mapping.email_message_id);
	}

	const keyboard = await buildEmailKeyboard(env, mapping.email_message_id, account.id, starred);
	return { ok: true, keyboard, emailMessageId: mapping.email_message_id };
}

/** 通过 Telegram 消息标记对应邮件为已读 */
export async function markAsReadByMessage(env: Env, chatId: string, messageId: number): Promise<void> {
	const mapping = await getMessageMapping(env.DB, chatId, messageId);
	if (!mapping) {
		console.log(`No mapping found for chat=${chatId}, message=${messageId}`);
		return;
	}

	const account = await getAccountById(env.DB, mapping.account_id);
	if (!account) return;

	try {
		const provider = getEmailProvider(account, env);
		await provider.markAsRead(mapping.email_message_id);
		console.log(`Marked as read: message=${mapping.email_message_id}`);
	} catch (err) {
		await reportErrorToObservability(env, 'bot.mark_read_failed', err, { messageId: mapping.email_message_id });
	}
}

/** 标记用户所有账号的未读邮件为已读 */
export async function markAllAsRead(env: Env, userId: string, maxPerAccount: number = 20): Promise<{ success: number; failed: number }> {
	const accounts = await getOwnAccounts(env.DB, userId);
	let success = 0;
	let failed = 0;

	for (const account of accounts) {
		try {
			const provider = getEmailProvider(account, env);
			const unread = await provider.listUnread(maxPerAccount);
			await Promise.all(
				unread.map(async (msg) => {
					try {
						await provider.markAsRead(msg.id);
						success++;
					} catch {
						failed++;
					}
				}),
			);
		} catch (err) {
			await reportErrorToObservability(env, 'bot.mark_all_read_failed', err, { accountId: account.id });
			failed++;
		}
	}

	return { success, failed };
}

/** 通过 Telegram 消息将对应邮件标记为垃圾 */
export async function markAsJunkByMessage(env: Env, chatId: string, messageId: number): Promise<{ ok: true; emailMessageId: string; accountId: number } | { ok: false; reason: string }> {
	const mapping = await getMessageMapping(env.DB, chatId, messageId);
	if (!mapping) return { ok: false, reason: '消息映射未找到' };

	const account = await getAccountById(env.DB, mapping.account_id);
	if (!account) return { ok: false, reason: '账号未找到' };

	const provider = getEmailProvider(account, env);
	await provider.markAsJunk(mapping.email_message_id);
	return { ok: true, emailMessageId: mapping.email_message_id, accountId: mapping.account_id };
}

/** 删除用户所有账号的垃圾邮件 */
export async function deleteAllJunkEmails(env: Env, userId: string): Promise<{ success: number; failed: number }> {
	const accounts = await getOwnAccounts(env.DB, userId);
	let success = 0;
	let failed = 0;

	for (const account of accounts) {
		try {
			const provider = getEmailProvider(account, env);
			const count = await provider.deleteAllJunk();
			success += count;
		} catch (err) {
			await reportErrorToObservability(env, 'bot.delete_all_junk_failed', err, { accountId: account.id });
			failed++;
		}
	}

	return { success, failed };
}

/** 批量同步 Telegram 消息的星标按钮状态（starred 列表刷新时调用） */
export async function syncStarButtonsForMappings(env: Env, mappings: MessageMapping[], account: Account): Promise<void> {
	await Promise.all(
		mappings.map(async (m) => {
			try {
				const keyboard = await buildEmailKeyboard(env, m.email_message_id, account.id, true);
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
}
