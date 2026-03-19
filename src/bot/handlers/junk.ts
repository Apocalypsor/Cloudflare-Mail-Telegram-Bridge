import type { Bot } from 'grammy';
import { getAccountById } from '@db/accounts';
import { deleteMappingByEmailId, getMessageMapping } from '@db/message-map';
import { getEmailProvider } from '@services/email/provider';
import { deleteMessage } from '@services/telegram';
import { reportErrorToObservability } from '@utils/observability';
import type { Env } from '@/types';

/** 标记为垃圾邮件 inline button callback */
export function registerJunkHandler(bot: Bot, env: Env) {
	bot.callbackQuery('junk_mark', async (ctx) => {
		const msg = ctx.callbackQuery.message;
		if (!msg) return;

		try {
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

			// 直接从邮件服务删除
			const provider = getEmailProvider(account, env);
			await provider.deleteMessage(mapping.email_message_id);

			// 删除 TG 消息和映射
			await deleteMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id).catch(() => {});
			await deleteMappingByEmailId(env.DB, mapping.email_message_id, mapping.account_id).catch(() => {});

			await ctx.answerCallbackQuery({ text: '🗑 已删除垃圾邮件' });
			console.log(`Deleted junk: email=${mapping.email_message_id}`);
		} catch (err) {
			await reportErrorToObservability(env, 'bot.junk_mark_failed', err);
			await ctx.answerCallbackQuery({ text: '操作失败，请重试' });
		}
	});
}
