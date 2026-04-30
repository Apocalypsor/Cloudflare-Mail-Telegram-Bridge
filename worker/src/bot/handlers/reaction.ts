import type { Env } from "@worker/types";
import { markAsReadByMessage } from "@worker/utils/message-actions";
import { reportErrorToObservability } from "@worker/utils/observability";
import type { Bot } from "grammy";

/** 任意 emoji reaction → 标记 Gmail 已读（同时支持群组和频道） */
export function registerReactionHandler(bot: Bot, env: Env) {
  // 群组/私聊：per-user reaction
  bot.on("message_reaction", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const messageId = ctx.messageReaction.message_id;
    console.log(`Reaction received: chat=${chatId}, message=${messageId}`);

    const hasNewReaction = (ctx.messageReaction.new_reaction || []).length > 0;
    if (!hasNewReaction) return;

    await markAsReadByMessage(env, chatId, messageId).catch((err) =>
      reportErrorToObservability(env, "reaction.mark_read_failed", err, {
        chatId,
        messageId,
      }),
    );
  });

  // 频道：匿名 reaction（只有数量）
  bot.on("message_reaction_count", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const messageId = ctx.messageReactionCount.message_id;
    const totalCount = (ctx.messageReactionCount.reactions || []).reduce(
      (sum, r) => sum + r.total_count,
      0,
    );
    console.log(
      `Reaction count update: chat=${chatId}, message=${messageId}, total=${totalCount}`,
    );

    if (totalCount <= 0) return;

    await markAsReadByMessage(env, chatId, messageId).catch((err) =>
      reportErrorToObservability(env, "reaction.mark_read_failed", err, {
        chatId,
        messageId,
      }),
    );
  });
}
