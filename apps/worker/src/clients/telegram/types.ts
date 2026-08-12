import type { Env } from "@worker/types";

export interface TelegramErrorPayload {
  description?: unknown;
  parameters?: {
    retry_after?: unknown;
  };
}

export interface TelegramSendResult {
  messageId: number;
  followupError?: unknown;
}

export type TelegramApiResponse<T> = { result: T };

export type DeleteMessageResult =
  | "deleted"
  | "not_found"
  | "rate_limited"
  | "unavailable";

export type PinResult = "ok" | "not_found" | "rate_limited";

export type TelegramClientEnv = Pick<
  Env,
  "TELEGRAM_BOT_TOKEN" | "TELEGRAM_RATE_LIMITER"
>;
