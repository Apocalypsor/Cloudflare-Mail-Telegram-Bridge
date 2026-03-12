import { InlineKeyboard } from 'grammy';
import { getAccountById } from '../db/accounts';
import { getMessageMapping, updateStarred } from '../db/message-map';
import type { Env } from '../types';
import { getEmailProvider } from './email/provider';
import { buildEmailKeyboard } from './keyboard';
import { reportErrorToObservability } from './observability';

type ToggleStarResult =
	| { ok: true; keyboard: InlineKeyboard; emailMessageId: string }
	| { ok: false; reason: string };

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
	await updateStarred(env.DB, chatId, messageId, starred);

	const keyboard = await buildEmailKeyboard(env, mapping.email_message_id, mapping.account_id, chatId, starred);
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
