import { http } from "@worker/clients/http";
import { TG_API_BASE, TG_MEDIA_GROUP_LIMIT } from "@worker/constants";
import type {
  TelegramRateLimitReason,
  TelegramRateLimitReservation,
} from "@worker/durable-objects/telegram-rate-limiter";
import type { Attachment, Env } from "@worker/types";
import { sleep } from "@worker/utils/sleep";
import { HTTPError } from "ky";

interface TelegramErrorPayload {
  description?: unknown;
  parameters?: {
    retry_after?: unknown;
  };
}

export interface TelegramSendResult {
  messageId: number;
  followupError?: unknown;
}

type TelegramApiResponse<T> = { result: T };

export type DeleteMessageResult =
  | "deleted"
  | "not_found"
  | "rate_limited"
  | "unavailable";

const TELEGRAM_GATE_NAME = "default";
const TELEGRAM_GATE_MAX_INLINE_WAIT_MS = 5_000;
const TELEGRAM_DEFAULT_RETRY_AFTER_SECONDS = 5;

export class TelegramRateLimitError extends Error {
  readonly delaySeconds: number;
  readonly label: string;
  readonly reason: TelegramRateLimitReason;

  constructor(
    label: string,
    delaySeconds: number,
    reason: TelegramRateLimitReason,
    description?: string,
    cause?: unknown,
  ) {
    super(
      `TG ${label} 429: retry after ${delaySeconds}s${description ? ` (${description})` : ""}`,
      { cause },
    );
    this.name = "TelegramRateLimitError";
    this.delaySeconds = delaySeconds;
    this.label = label;
    this.reason = reason;
  }
}

export const isTelegramRateLimitError = (
  err: unknown,
): err is TelegramRateLimitError => err instanceof TelegramRateLimitError;

const isEntityParseError = (description: string | undefined): boolean => {
  return !!description && /can't parse entities/i.test(description);
};

const markdownV2ToPlainText = (text: string): string => {
  let out = text;
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1: $2");
  out = out.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
  return out;
};

const extractTelegramDescription = (payload: unknown): string => {
  if (typeof payload === "string" && payload) return payload;
  if (!payload || typeof payload !== "object" || !("description" in payload))
    return "Unknown Telegram error";
  const desc = (payload as { description?: unknown }).description;
  return typeof desc === "string" ? desc : "Unknown Telegram error";
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

const reserveTelegramRequest = async (
  env: Env,
  chatId: string,
  label: string,
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
        label,
        reservation.delaySeconds,
        reservation.reason,
      );
    }

    await sleep(reservation.delayMs);
  }
};

const recordTelegramRateLimit = async (
  env: Env,
  chatId: string,
  label: string,
  retryAfterSeconds: number,
  description: string,
  cause: unknown,
): Promise<never> => {
  let reservation: TelegramRateLimitReservation | null = null;
  try {
    reservation = await env.TELEGRAM_RATE_LIMITER.getByName(
      TELEGRAM_GATE_NAME,
    ).recordRateLimit(chatId, retryAfterSeconds);
  } catch {
    // If the limiter cannot be updated, still surface a structured retry delay.
  }

  throw new TelegramRateLimitError(
    label,
    reservation?.ok === false
      ? reservation.delaySeconds
      : Math.max(1, retryAfterSeconds),
    "blocked",
    description,
    cause,
  );
};

const maybeThrowTelegramRateLimit = async (
  env: Env,
  chatId: string,
  label: string,
  err: HTTPError,
): Promise<void> => {
  const errDescription = extractTelegramDescription(err.data);
  const retryAfterSeconds =
    extractTelegramRetryAfter(err.data) ??
    extractRetryAfterFromDescription(errDescription) ??
    TELEGRAM_DEFAULT_RETRY_AFTER_SECONDS;
  if (
    err.response.status === 429 ||
    /too many requests|retry after/i.test(errDescription)
  ) {
    await recordTelegramRateLimit(
      env,
      chatId,
      label,
      retryAfterSeconds,
      errDescription,
      err,
    );
  }
};

const telegramRequest = async <T>(
  env: Env,
  chatId: string,
  label: string,
  request: () => Promise<T>,
): Promise<T> => {
  await reserveTelegramRequest(env, chatId, label);
  try {
    return await request();
  } catch (err) {
    if (err instanceof HTTPError) {
      await maybeThrowTelegramRateLimit(env, chatId, label, err);
    }
    throw err;
  }
};

const postJsonResult = async <T>(
  env: Env,
  chatId: string,
  url: string,
  payload: Record<string, unknown>,
  label: string,
): Promise<T> => {
  const data = await telegramRequest(env, chatId, label, () =>
    http.post(url, { json: payload }).json<TelegramApiResponse<T>>(),
  );
  return data.result;
};

const postFormResult = async <T>(
  env: Env,
  chatId: string,
  url: string,
  form: FormData,
  label: string,
): Promise<T> => {
  const data = await telegramRequest(env, chatId, label, () =>
    http.post(url, { body: form }).json<TelegramApiResponse<T>>(),
  );
  return data.result;
};

/**
 * 通用 Telegram JSON API 请求，带 MarkdownV2 parse error 自动回退。
 * 429 会解析 Telegram `parameters.retry_after` 并写回全局 gate。
 * 当 parse_mode 存在且返回 entity parse error 时，自动去掉 parse_mode 并将 text/caption 转为纯文本重试。
 */
const tgPost = async <T = unknown>(
  env: Env,
  chatId: string,
  url: string,
  payload: Record<string, unknown>,
  label: string,
): Promise<T> => {
  try {
    return await postJsonResult(env, chatId, url, payload, label);
  } catch (err) {
    if (!(err instanceof HTTPError)) throw err;
    const { response } = err;

    const errDescription = extractTelegramDescription(err.data);

    // parse_mode 错误 → 回退纯文本
    if (payload.parse_mode && isEntityParseError(errDescription)) {
      const textKey = "text" in payload ? "text" : "caption";
      const textValue = payload[textKey];
      if (typeof textValue === "string") {
        console.warn(`TG ${label} parse_mode failed, retrying as plain text`);
        const { parse_mode: _, ...rest } = payload;
        rest[textKey] = markdownV2ToPlainText(textValue);
        try {
          return await postJsonResult(env, chatId, url, rest, label);
        } catch (fallbackErr) {
          if (!(fallbackErr instanceof HTTPError)) throw fallbackErr;
          const fallbackDescription = extractTelegramDescription(
            fallbackErr.data,
          );
          throw new Error(
            `TG ${label} ${fallbackErr.response.status}: ${fallbackDescription}`,
          );
        }
      }
    }

    throw new Error(`TG ${label} ${response.status}: ${errDescription}`);
  }
};

/** 发送纯文字消息，返回 message_id。`extras` 用于透传 reply_parameters /
 *  link_preview_options 等可选字段（与 chat_id/text/parse_mode 同层）。 */
export const sendTextMessage = async (
  env: Env,
  chatId: string,
  text: string,
  replyMarkup?: unknown,
  extras?: Record<string, unknown>,
): Promise<number> => {
  const url = `${TG_API_BASE}${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
    ...extras,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const data = await tgPost<{ message_id: number }>(
    env,
    chatId,
    url,
    payload,
    "sendMessage",
  );
  return data.message_id;
};

/** 编辑已发送的文字消息 */
export const editTextMessage = async (
  env: Env,
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: unknown,
): Promise<void> => {
  const url = `${TG_API_BASE}${env.TELEGRAM_BOT_TOKEN}/editMessageText`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "MarkdownV2",
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await tgPost(env, chatId, url, payload, "editMessageText");
};

const attToBlob = (att: Attachment): Blob => {
  const mime = att.mimeType || "application/octet-stream";
  // Cast through unknown：Workers runtime 的 ArrayBufferLike 跟 page tsconfig
  // lib (DOM) 里的 BlobPart 不严格相容，运行时一致。
  const part =
    typeof att.content === "string"
      ? new TextEncoder().encode(att.content)
      : att.content;
  return new Blob([part as unknown as ArrayBuffer], { type: mime });
};

/** pinChatMessage 的精细返回值 —— 上层（reminder dispatch）需要分支。 */
export type PinResult = "ok" | "not_found" | "rate_limited";

export const runTelegramFollowups = async (
  messageId: number,
  operation: () => Promise<void>,
): Promise<TelegramSendResult> => {
  try {
    await operation();
    return { messageId };
  } catch (followupError) {
    return { messageId, followupError };
  }
};

/**
 * 发送消息 + 附件，返回首条可见消息的 ID。多附件后续发送失败时保留
 * `messageId` 并返回 `followupError`，让上层先建 mapping，避免整封重发。
 * - 1 个附件: sendDocument + caption + reply_markup
 * - 多个附件: 先发文字消息（带 reply_markup），再发媒体组作为回复
 * - 超过 10 个附件: 分批发送，每批最多 10 个
 */
export const sendWithAttachments = async (
  env: Env,
  chatId: string,
  caption: string,
  attachments: Attachment[],
  replyMarkup?: unknown,
  messageThreadId?: number | null,
): Promise<TelegramSendResult> => {
  try {
    if (attachments.length === 1) {
      const att = attachments[0];
      const blob = attToBlob(att);
      const form = new FormData();
      form.append("chat_id", chatId);
      if (messageThreadId != null) {
        form.append("message_thread_id", String(messageThreadId));
      }
      form.append("document", blob, att.filename || "attachment");
      form.append("caption", caption);
      form.append("parse_mode", "MarkdownV2");
      if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));

      const url = `${TG_API_BASE}${env.TELEGRAM_BOT_TOKEN}/sendDocument`;
      try {
        const data = await postFormResult<{ message_id: number }>(
          env,
          chatId,
          url,
          form,
          "sendDocument",
        );
        return { messageId: data.message_id };
      } catch (err) {
        if (!(err instanceof HTTPError)) throw err;

        const errDescription = extractTelegramDescription(err.data);
        console.error("TG sendDocument failed payload:", {
          chatId,
          captionLength: caption.length,
          filename: att.filename || "attachment",
          description: errDescription,
        });

        if (isEntityParseError(errDescription)) {
          console.warn(
            "TG sendDocument parse_mode failed, retrying as plain caption",
          );
          const fallbackForm = new FormData();
          fallbackForm.append("chat_id", chatId);
          if (messageThreadId != null) {
            fallbackForm.append("message_thread_id", String(messageThreadId));
          }
          fallbackForm.append("document", blob, att.filename || "attachment");
          fallbackForm.append("caption", markdownV2ToPlainText(caption));
          if (replyMarkup)
            fallbackForm.append("reply_markup", JSON.stringify(replyMarkup));
          const fallbackData = await postFormResult<{ message_id: number }>(
            env,
            chatId,
            url,
            fallbackForm,
            "sendDocument",
          );
          return { messageId: fallbackData.message_id };
        }

        throw new Error(
          `TG sendDocument ${err.response.status}: ${errDescription}`,
        );
      }
    } else {
      const textMsgId = await sendTextMessage(
        env,
        chatId,
        caption,
        replyMarkup,
        messageThreadId != null
          ? { message_thread_id: messageThreadId }
          : undefined,
      );

      return runTelegramFollowups(textMsgId, async () => {
        const chunks: Attachment[][] = [];
        for (let i = 0; i < attachments.length; i += TG_MEDIA_GROUP_LIMIT) {
          chunks.push(attachments.slice(i, i + TG_MEDIA_GROUP_LIMIT));
        }
        for (const chunk of chunks) {
          await sendMediaGroupChunk(
            env,
            chatId,
            "",
            chunk,
            textMsgId,
            messageThreadId,
          );
        }
      });
    }
  } catch (e) {
    if (isTelegramRateLimitError(e)) throw e;
    throw new Error(
      `发送附件消息异常: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

/** 编辑附件消息的 caption */
export const editMessageCaption = async (
  env: Env,
  chatId: string,
  messageId: number,
  caption: string,
  replyMarkup?: unknown,
): Promise<void> => {
  const url = `${TG_API_BASE}${env.TELEGRAM_BOT_TOKEN}/editMessageCaption`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: "MarkdownV2",
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await tgPost(env, chatId, url, payload, "editMessageCaption");
};

/**
 * 置顶消息。幂等：已置顶或消息不存在时静默返回；其它错误（无权限等）抛出。
 * 默认 disable_notification=true，避免每次 ⭐ 都刷一条「已置顶」提示。
 */
export const pinChatMessage = async (
  env: Env,
  chatId: string,
  messageId: number,
): Promise<PinResult> => {
  const url = `${TG_API_BASE}${env.TELEGRAM_BOT_TOKEN}/pinChatMessage`;
  try {
    await tgPost(
      env,
      chatId,
      url,
      { chat_id: chatId, message_id: messageId, disable_notification: true },
      "pinChatMessage",
    );
    return "ok";
  } catch (err) {
    if (err instanceof Error) {
      if (/already pinned/i.test(err.message)) return "ok";
      // 消息不存在（被用户删了）→ 上层可能想重发。
      if (/not found|MESSAGE_ID_INVALID|message to pin/i.test(err.message))
        return "not_found";
      // 限流 / 群权限不够 / 其它 TG 临时错误 —— 不算失败，下次同步再试。
      // 之前 429 会冒到 syncStarPinState 里 reportErrorToObservability，刷屏告警。
      if (/too many requests|429/i.test(err.message)) return "rate_limited";
    }
    throw err;
  }
};

/** 取消置顶指定消息。幂等：未置顶 / 消息不存在 / 被限流，全部静默返回。 */
export const unpinChatMessage = async (
  env: Env,
  chatId: string,
  messageId: number,
): Promise<void> => {
  const url = `${TG_API_BASE}${env.TELEGRAM_BOT_TOKEN}/unpinChatMessage`;
  try {
    await tgPost(
      env,
      chatId,
      url,
      { chat_id: chatId, message_id: messageId },
      "unpinChatMessage",
    );
  } catch (err) {
    if (
      err instanceof Error &&
      /not found|not pinned|too many requests|429|MESSAGE_ID_INVALID/i.test(
        err.message,
      )
    )
      return;
    throw err;
  }
};

/** 设置/更新消息的 inline keyboard */
export const setReplyMarkup = async (
  env: Env,
  chatId: string,
  messageId: number,
  replyMarkup: unknown,
): Promise<void> => {
  const url = `${TG_API_BASE}${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`;
  await tgPost(
    env,
    chatId,
    url,
    { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup },
    "editMessageReplyMarkup",
  );
};

/** 生成指向 Telegram 群组消息的深链接 */
export const buildTgMessageLink = (
  chatId: string,
  messageId: number,
  messageThreadId?: number | null,
): string => {
  const numericId = chatId.replace(/^-100/, "");
  if (messageThreadId != null) {
    return `https://t.me/c/${numericId}/${messageThreadId}/${messageId}`;
  }
  return `https://t.me/c/${numericId}/${messageId}`;
};

export const deleteMessage = async (
  env: Env,
  chatId: string,
  messageId: number,
): Promise<void> => {
  const url = `${TG_API_BASE}${env.TELEGRAM_BOT_TOKEN}/deleteMessage`;
  await tgPost(
    env,
    chatId,
    url,
    { chat_id: chatId, message_id: messageId },
    "deleteMessage",
  );
};

/** 删除消息并把可重试 / 幂等结果交给调用方判断是否可以清 mapping。 */
export const deleteMessageIfPresent = async (
  env: Env,
  chatId: string,
  messageId: number,
): Promise<DeleteMessageResult> => {
  try {
    await deleteMessage(env, chatId, messageId);
    return "deleted";
  } catch (err) {
    if (err instanceof Error) {
      if (
        /message to delete not found|not found|MESSAGE_ID_INVALID/i.test(
          err.message,
        )
      ) {
        return "not_found";
      }
      if (/too many requests|429/i.test(err.message)) {
        return "rate_limited";
      }
      if (
        /can't be deleted|cannot be deleted|not enough rights/i.test(
          err.message,
        )
      ) {
        return "unavailable";
      }
    }
    throw err;
  }
};

const sendMediaGroupChunk = async (
  env: Env,
  chatId: string,
  caption: string,
  attachments: Attachment[],
  replyToMessageId?: number,
  messageThreadId?: number | null,
): Promise<number> => {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (messageThreadId != null) {
    form.append("message_thread_id", String(messageThreadId));
  }
  if (replyToMessageId) {
    form.append(
      "reply_parameters",
      JSON.stringify({ message_id: replyToMessageId }),
    );
  }

  const media = attachments.map((att, i) => {
    const fieldName = `file${i}`;
    const blob = attToBlob(att);
    form.append(fieldName, blob, att.filename || `attachment_${i + 1}`);

    const entry: Record<string, string> = {
      type: "document",
      media: `attach://${fieldName}`,
    };
    if (i === 0 && caption) {
      entry.caption = caption;
      entry.parse_mode = "MarkdownV2";
    }
    return entry;
  });

  form.append("media", JSON.stringify(media));

  const url = `${TG_API_BASE}${env.TELEGRAM_BOT_TOKEN}/sendMediaGroup`;
  try {
    const data = await postFormResult<Array<{ message_id: number }>>(
      env,
      chatId,
      url,
      form,
      "sendMediaGroup",
    );
    return data[0].message_id;
  } catch (err) {
    if (!(err instanceof HTTPError)) throw err;

    const errDescription = extractTelegramDescription(err.data);
    console.error("TG sendMediaGroup failed payload:", {
      chatId,
      captionLength: caption.length,
      attachments: attachments.length,
      description: errDescription,
    });

    if (isEntityParseError(errDescription) && caption) {
      console.warn(
        "TG sendMediaGroup parse_mode failed, retrying as plain caption",
      );
      const fallbackForm = new FormData();
      fallbackForm.append("chat_id", chatId);
      if (messageThreadId != null) {
        fallbackForm.append("message_thread_id", String(messageThreadId));
      }
      const fallbackMedia = attachments.map((att, i) => {
        const fieldName = `file${i}`;
        const blob = attToBlob(att);
        fallbackForm.append(
          fieldName,
          blob,
          att.filename || `attachment_${i + 1}`,
        );
        const entry: Record<string, string> = {
          type: "document",
          media: `attach://${fieldName}`,
        };
        if (i === 0) {
          entry.caption = markdownV2ToPlainText(caption);
        }
        return entry;
      });
      fallbackForm.append("media", JSON.stringify(fallbackMedia));
      const fallbackData = await postFormResult<Array<{ message_id: number }>>(
        env,
        chatId,
        url,
        fallbackForm,
        "sendMediaGroup",
      );
      return fallbackData[0].message_id;
    }

    throw new Error(
      `TG sendMediaGroup ${err.response.status}: ${errDescription}`,
    );
  }
};
