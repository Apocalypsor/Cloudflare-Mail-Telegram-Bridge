import { InlineKeyboard } from 'grammy';
import { STAR_KEYBOARD, starKeyboardWithMailUrl, STARRED_KEYBOARD, starredKeyboardWithMailUrl } from '../bot';
import { getMessageMapping } from '../db/message-map';
import type { Env } from '../types';
import { generateMailToken } from '../utils/hash';

/** 根据星标状态构建邮件消息键盘 */
export async function buildEmailKeyboard(
	env: Env,
	emailMessageId: string,
	accountId: number,
	chatId: string,
	starred: boolean,
): Promise<InlineKeyboard> {
	if (env.WORKER_URL) {
		const mailToken = await generateMailToken(env.ADMIN_SECRET, emailMessageId, accountId, chatId);
		const mailUrl = `${env.WORKER_URL.replace(/\/$/, '')}/mail/${emailMessageId}?accountId=${accountId}&chatId=${encodeURIComponent(chatId)}&t=${mailToken}`;
		return starred ? starredKeyboardWithMailUrl(mailUrl) : starKeyboardWithMailUrl(mailUrl);
	}
	return starred ? STARRED_KEYBOARD : STAR_KEYBOARD;
}

/** 从 DB 读取当前星标状态后构建键盘（LLM 处理后编辑消息使用） */
export async function resolveStarredKeyboard(
	env: Env,
	chatId: string,
	tgMessageId: number,
	emailMessageId: string,
	accountId: number,
): Promise<InlineKeyboard> {
	const mapping = await getMessageMapping(env.DB, chatId, tgMessageId);
	return buildEmailKeyboard(env, emailMessageId, accountId, chatId, !!mapping?.starred);
}
