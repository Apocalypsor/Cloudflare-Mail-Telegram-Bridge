import type { Bot } from "grammy";
import type { Env } from "@/types";

/**
 * TG 对 pinChatMessage 即使带 `disable_notification: true` 也会产生一条「Bot pinned
 * this message」的服务消息。这里监听 `pinned_message` 更新，识别出是我们自己 bot 的
 * 操作后直接删掉 —— 星标刷一次 pin 就多一条垃圾消息，体验很差。
 *
 * 只删 `from.id == bot.id` 的服务消息，避免误伤用户/管理员手动置顶产生的通知。
 */
export function registerPinCleanupHandler(bot: Bot, _env: Env) {
  bot.on("message:pinned_message", async (ctx) => {
    if (ctx.from?.id !== ctx.me.id) return;
    await ctx.deleteMessage().catch(() => {});
  });
}
