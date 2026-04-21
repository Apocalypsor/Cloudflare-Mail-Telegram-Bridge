import type { Bot } from "grammy";
import type { Env } from "@/types";

/**
 * TG 对 pinChatMessage 即使带 `disable_notification: true` 也会产生一条「Bot pinned
 * this message」的服务消息。这里监听 `pinned_message` 更新，识别出是我们自己 bot 的
 * 操作后直接删掉 —— 星标刷一次 pin 就多一条垃圾消息，体验很差。
 *
 * 群/私聊里走 `message`，频道里走 `channel_post` —— 两个都监听。
 * webhook `allowed_updates` 必须同时包含 `message` 和 `channel_post`。
 *
 * 区分逻辑：
 * - 群/私聊：`from.id == bot.id` 才删，避免误伤人工置顶产生的通知。
 * - 频道：所有 channel post 的 actor 都是 `sender_chat`（频道本身），`from` 缺失，
 *   bot 和人工 admin 触发的 pin 在消息结构上无法区分。所以频道里直接删所有
 *   pinned_message 服务消息——反正顶部 pin banner 不受影响，只是把聊天流里的
 *   "频道 pinned 「xxx」"那条噪音去掉。
 */
export function registerPinCleanupHandler(bot: Bot, _env: Env) {
  bot.on(
    ["message:pinned_message", "channel_post:pinned_message"],
    async (ctx) => {
      const isChannel = ctx.chat?.type === "channel";
      if (!isChannel && ctx.from?.id !== ctx.me.id) return;
      await ctx.deleteMessage().catch(() => {});
    },
  );
}
