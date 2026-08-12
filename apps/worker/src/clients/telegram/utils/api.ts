import { http } from "@worker/clients/http";
import type {
  TelegramApiResponse,
  TelegramClientEnv,
  TelegramErrorPayload,
} from "@worker/clients/telegram/types";
import { TG_API_BASE } from "@worker/constants";
import type { TelegramRateLimitReservation } from "@worker/durable-objects/telegram-rate-limiter";
import {
  TelegramApiError,
  TelegramApiErrorCode,
  TelegramRateLimitError,
} from "@worker/errors/telegram";
import { sleep } from "@worker/utils/sleep";
import { HTTPError } from "ky";

const TELEGRAM_GATE_NAME = "default";
const TELEGRAM_GATE_MAX_INLINE_WAIT_MS = 5_000;
const TELEGRAM_DEFAULT_RETRY_AFTER_SECONDS = 5;

export const postTelegramJson = async <T = unknown>(
  env: TelegramClientEnv,
  chatId: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> => {
  try {
    return await postJsonResult<T>(env, chatId, method, payload);
  } catch (error) {
    if (!(error instanceof HTTPError)) throw error;
    const apiError = toTelegramApiError(method, error);
    if (
      payload.parse_mode &&
      apiError.code === TelegramApiErrorCode.EntityParseFailed &&
      typeof payload.text === "string"
    ) {
      console.warn(`TG ${method} parse_mode failed, retrying as plain text`);
      const { parse_mode: _, ...plainPayload } = payload;
      plainPayload.text = markdownV2ToPlainText(payload.text);
      return postTelegramJson(env, chatId, method, plainPayload);
    }
    throw apiError;
  }
};

export const postTelegramForm = async <T = unknown>(
  env: TelegramClientEnv,
  chatId: string,
  method: string,
  form: FormData,
): Promise<T> => {
  try {
    const data = await telegramRequest(env, chatId, method, () =>
      http
        .post(telegramUrl(env, method), { body: form })
        .json<TelegramApiResponse<T>>(),
    );
    return data.result;
  } catch (error) {
    if (!(error instanceof HTTPError)) throw error;
    throw toTelegramApiError(method, error);
  }
};

const postJsonResult = async <T>(
  env: TelegramClientEnv,
  chatId: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> => {
  const data = await telegramRequest(env, chatId, method, () =>
    http
      .post(telegramUrl(env, method), { json: payload })
      .json<TelegramApiResponse<T>>(),
  );
  return data.result;
};

const telegramRequest = async <T>(
  env: TelegramClientEnv,
  chatId: string,
  method: string,
  request: () => Promise<T>,
): Promise<T> => {
  await reserveTelegramRequest(env, chatId, method);
  try {
    return await request();
  } catch (error) {
    if (error instanceof HTTPError) {
      await maybeThrowTelegramRateLimit(env, chatId, method, error);
    }
    throw error;
  }
};

const reserveTelegramRequest = async (
  env: TelegramClientEnv,
  chatId: string,
  method: string,
): Promise<void> => {
  const limiter = env.TELEGRAM_RATE_LIMITER.getByName(TELEGRAM_GATE_NAME);
  const startedAt = Date.now();

  for (;;) {
    const reservation = await limiter.reserve(chatId);
    if (reservation.ok) return;
    if (
      Date.now() - startedAt + reservation.delayMs >
      TELEGRAM_GATE_MAX_INLINE_WAIT_MS
    ) {
      throw new TelegramRateLimitError(
        method,
        reservation.delaySeconds,
        reservation.reason,
      );
    }
    await sleep(reservation.delayMs);
  }
};

const maybeThrowTelegramRateLimit = async (
  env: TelegramClientEnv,
  chatId: string,
  method: string,
  error: HTTPError,
): Promise<void> => {
  const description = extractTelegramDescription(error.data);
  const retryAfterSeconds =
    extractTelegramRetryAfter(error.data) ??
    extractRetryAfterFromDescription(description) ??
    TELEGRAM_DEFAULT_RETRY_AFTER_SECONDS;
  if (
    error.response.status !== 429 &&
    !/too many requests|retry after/i.test(description)
  ) {
    return;
  }

  let reservation: TelegramRateLimitReservation | null = null;
  try {
    reservation = await env.TELEGRAM_RATE_LIMITER.getByName(
      TELEGRAM_GATE_NAME,
    ).recordRateLimit(chatId, retryAfterSeconds);
  } catch {
    // Limiter state is best-effort; callers still need a structured delay.
  }

  throw new TelegramRateLimitError(
    method,
    reservation?.ok === false
      ? reservation.delaySeconds
      : Math.max(1, retryAfterSeconds),
    "blocked",
    description,
    error,
  );
};

const toTelegramApiError = (
  method: string,
  error: HTTPError,
): TelegramApiError =>
  new TelegramApiError(
    method,
    error.response.status,
    extractTelegramDescription(error.data),
    error,
  );

const extractTelegramDescription = (payload: unknown): string => {
  if (typeof payload === "string" && payload) return payload;
  if (!payload || typeof payload !== "object" || !("description" in payload)) {
    return "Unknown Telegram error";
  }
  const description = (payload as { description?: unknown }).description;
  return typeof description === "string"
    ? description
    : "Unknown Telegram error";
};

const extractTelegramRetryAfter = (payload: unknown): number | null => {
  if (!payload || typeof payload !== "object") return null;
  const parameters = (payload as TelegramErrorPayload).parameters;
  if (!parameters || typeof parameters !== "object") return null;
  const retryAfter = parameters.retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    return Math.max(1, Math.ceil(retryAfter));
  }
  if (typeof retryAfter === "string") {
    const parsed = Number.parseInt(retryAfter, 10);
    return Number.isFinite(parsed) ? Math.max(1, parsed) : null;
  }
  return null;
};

const extractRetryAfterFromDescription = (
  description: string,
): number | null => {
  const match = /\bretry after (\d+)\b/i.exec(description);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : null;
};

const markdownV2ToPlainText = (text: string): string => {
  let output = text;
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1: $2");
  output = output.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
  return output;
};

const telegramUrl = (env: TelegramClientEnv, method: string): string =>
  `${TG_API_BASE}${env.TELEGRAM_BOT_TOKEN}/${method}`;
