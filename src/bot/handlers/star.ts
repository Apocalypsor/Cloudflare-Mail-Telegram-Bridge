import type { Bot } from 'grammy';
import { toggleStar } from '../../services/message-actions';
import { reportErrorToObservability } from '../../services/observability';
import type { Env } from '../../types';

/** 星标/取消星标 inline button callback */
export function registerStarHandler(bot: Bot, env: Env) {
	bot.callbackQuery('star', async (ctx) => {
		const msg = ctx.callbackQuery.message;
		if (!msg) return;

		try {
			const result = await toggleStar(env, String(msg.chat.id), msg.message_id, true);
			if (!result.ok) {
				await ctx.answerCallbackQuery({ text: result.reason });
				return;
			}
			await ctx.editMessageReplyMarkup({ reply_markup: result.keyboard });
			await ctx.answerCallbackQuery({ text: '⭐ 已加星标' });
			console.log(`Starred: email=${result.emailMessageId}`);
		} catch (err) {
			await reportErrorToObservability(env, 'bot.star_failed', err);
			await ctx.answerCallbackQuery({ text: '操作失败，请重试' });
		}
	});

	bot.callbackQuery('unstar', async (ctx) => {
		const msg = ctx.callbackQuery.message;
		if (!msg) return;

		try {
			const result = await toggleStar(env, String(msg.chat.id), msg.message_id, false);
			if (!result.ok) {
				await ctx.answerCallbackQuery({ text: result.reason });
				return;
			}
			await ctx.editMessageReplyMarkup({ reply_markup: result.keyboard });
			await ctx.answerCallbackQuery({ text: '已取消星标' });
			console.log(`Unstarred: email=${result.emailMessageId}`);
		} catch (err) {
			await reportErrorToObservability(env, 'bot.unstar_failed', err);
			await ctx.answerCallbackQuery({ text: '操作失败，请重试' });
		}
	});
}
