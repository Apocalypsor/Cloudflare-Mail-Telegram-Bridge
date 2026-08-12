export { TelegramRateLimiter } from "@worker/durable-objects/telegram-rate-limiter";

export default {
  fetch(): Response {
    return new Response("test worker");
  },
} satisfies ExportedHandler;
