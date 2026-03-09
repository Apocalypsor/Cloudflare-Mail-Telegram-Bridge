import type { Bot } from 'grammy';
import { getAccountById } from '../../db/accounts';
import { getMessageMapping, updateStarred } from '../../db/message-map';
import { addStar, getAccessToken, removeStar } from '../../services/gmail';
import { reportErrorToObservability } from '../../services/observability';
import { STAR_KEYBOARD, STARRED_KEYBOARD, starKeyboardWithMailUrl, starredKeyboardWithMailUrl } from '../keyboards';
import type { Env } from '../../types';
import { generateMailToken } from '../../utils/hash';

/** 星标/取消星标 inline button callback */
export function registerStarHandler(bot: Bot, env: Env) {
	bot.callbackQuery('star', async (ctx) => {
		const msg = ctx.callbackQuery.message;
		if (!msg) return;

		const chatId = String(msg.chat.id);
		const mapping = await getMessageMapping(env.DB, chatId, msg.message_id);
		if (!mapping) {
			await ctx.answerCallbackQuery({ text: '消息映射未找到' });
			return;
		}

		const account = await getAccountById(env.DB, mapping.account_id);
		if (!account) {
			await ctx.answerCallbackQuery({ text: '账号未找到' });
			return;
		}

		try {
			const token = await getAccessToken(env, account);
			await addStar(token, mapping.gmail_message_id);
			await updateStarred(env.DB, chatId, msg.message_id, true);
			let keyboard = STARRED_KEYBOARD;
			if (env.WORKER_URL) {
				const mailToken = await generateMailToken(env.ADMIN_SECRET, mapping.gmail_message_id, chatId);
				const mailUrl = `${env.WORKER_URL.replace(/\/$/, '')}/mail/${mapping.gmail_message_id}?t=${mailToken}`;
				keyboard = starredKeyboardWithMailUrl(mailUrl);
			}
			await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
			await ctx.answerCallbackQuery({ text: '⭐ 已加星标' });
			console.log(`Starred: gmail=${mapping.gmail_message_id}`);
		} catch (err) {
			await reportErrorToObservability(env, 'bot.star_failed', err, { gmailMessageId: mapping.gmail_message_id });
			await ctx.answerCallbackQuery({ text: '操作失败，请重试' });
		}
	});

	bot.callbackQuery('unstar', async (ctx) => {
		const msg = ctx.callbackQuery.message;
		if (!msg) return;

		const chatId = String(msg.chat.id);
		const mapping = await getMessageMapping(env.DB, chatId, msg.message_id);
		if (!mapping) {
			await ctx.answerCallbackQuery({ text: '消息映射未找到' });
			return;
		}

		const account = await getAccountById(env.DB, mapping.account_id);
		if (!account) {
			await ctx.answerCallbackQuery({ text: '账号未找到' });
			return;
		}

		try {
			const token = await getAccessToken(env, account);
			await removeStar(token, mapping.gmail_message_id);
			await updateStarred(env.DB, chatId, msg.message_id, false);
			let keyboard = STAR_KEYBOARD;
			if (env.WORKER_URL) {
				const mailToken = await generateMailToken(env.ADMIN_SECRET, mapping.gmail_message_id, chatId);
				const mailUrl = `${env.WORKER_URL.replace(/\/$/, '')}/mail/${mapping.gmail_message_id}?t=${mailToken}`;
				keyboard = starKeyboardWithMailUrl(mailUrl);
			}
			await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
			await ctx.answerCallbackQuery({ text: '已取消星标' });
			console.log(`Unstarred: gmail=${mapping.gmail_message_id}`);
		} catch (err) {
			await reportErrorToObservability(env, 'bot.unstar_failed', err, { gmailMessageId: mapping.gmail_message_id });
			await ctx.answerCallbackQuery({ text: '操作失败，请重试' });
		}
	});
}
