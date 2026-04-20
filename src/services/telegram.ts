import { http } from "@utils/http";
import { HTTPError } from "ky";
import {
  TG_API_BASE,
  TG_CAPTION_LIMIT,
  TG_MEDIA_GROUP_LIMIT,
  TG_MSG_LIMIT,
} from "@/constants";
import type { Attachment } from "@/types";

export { TG_CAPTION_LIMIT, TG_MSG_LIMIT };

function isEntityParseError(description: string | undefined): boolean {
  return !!description && /can't parse entities/i.test(description);
}

function markdownV2ToPlainText(text: string): string {
  let out = text;
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1: $2");
  out = out.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
  return out;
}

function extractTelegramDescription(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("description" in payload))
    return "Unknown Telegram error";
  const desc = (payload as { description?: unknown }).description;
  return typeof desc === "string" ? desc : "Unknown Telegram error";
}

/**
 * 通用 Telegram JSON API 请求，带 MarkdownV2 parse error 自动回退。
 * 429 由 ky 内置 retry 自动处理。
 * 当 parse_mode 存在且返回 entity parse error 时，自动去掉 parse_mode 并将 text/caption 转为纯文本重试。
 */
async function tgPost<T = unknown>(
  url: string,
  payload: Record<string, unknown>,
  label: string,
): Promise<T> {
  try {
    return ((await http.post(url, { json: payload }).json()) as { result: T })
      .result;
  } catch (err) {
    if (!(err instanceof HTTPError)) throw err;
    const { response } = err;

    const errBody = (await response.json()) as unknown;
    const errDescription = extractTelegramDescription(errBody);

    // parse_mode 错误 → 回退纯文本
    if (payload.parse_mode && isEntityParseError(errDescription)) {
      const textKey = "text" in payload ? "text" : "caption";
      const textValue = payload[textKey];
      if (typeof textValue === "string") {
        console.warn(`TG ${label} parse_mode failed, retrying as plain text`);
        const { parse_mode: _, ...rest } = payload;
        rest[textKey] = markdownV2ToPlainText(textValue);
        return ((await http.post(url, { json: rest }).json()) as { result: T })
          .result;
      }
    }

    throw new Error(`TG ${label} ${response.status}: ${errDescription}`);
  }
}

/** 发送纯文字消息，返回 message_id */
export async function sendTextMessage(
  token: string,
  chatId: string,
  text: string,
  replyMarkup?: unknown,
): Promise<number> {
  const url = `${TG_API_BASE}${token}/sendMessage`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const data = await tgPost<{ message_id: number }>(
    url,
    payload,
    "sendMessage",
  );
  return data.message_id;
}

/** 编辑已发送的文字消息 */
export async function editTextMessage(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: unknown,
): Promise<void> {
  const url = `${TG_API_BASE}${token}/editMessageText`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "MarkdownV2",
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await tgPost(url, payload, "editMessageText");
}

function attToBlob(att: Attachment): Blob {
  const mime = att.mimeType || "application/octet-stream";
  return typeof att.content === "string"
    ? new Blob([new TextEncoder().encode(att.content)], { type: mime })
    : new Blob([att.content], { type: mime });
}

/**
 * 发送消息 + 附件，返回文字消息的 message_id。
 * - 1 个附件: sendDocument + caption + reply_markup
 * - 多个附件: 先发文字消息（带 reply_markup），再发媒体组作为回复
 * - 超过 10 个附件: 分批发送，每批最多 10 个
 */
export async function sendWithAttachments(
  token: string,
  chatId: string,
  caption: string,
  attachments: Attachment[],
  replyMarkup?: unknown,
): Promise<number> {
  try {
    if (attachments.length === 1) {
      const att = attachments[0];
      const blob = attToBlob(att);
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("document", blob, att.filename || "attachment");
      form.append("caption", caption);
      form.append("parse_mode", "MarkdownV2");
      if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));

      const url = `${TG_API_BASE}${token}/sendDocument`;
      try {
        const data = (await http.post(url, { body: form }).json()) as {
          result: { message_id: number };
        };
        return data.result.message_id;
      } catch (err) {
        if (!(err instanceof HTTPError)) throw err;
        const { response } = err;

        const errBody = (await response.json()) as { description?: string };
        console.error("TG sendDocument failed payload:", {
          chatId,
          captionLength: caption.length,
          filename: att.filename || "attachment",
          description: errBody.description,
        });

        if (isEntityParseError(errBody.description)) {
          console.warn(
            "TG sendDocument parse_mode failed, retrying as plain caption",
          );
          const fallbackForm = new FormData();
          fallbackForm.append("chat_id", chatId);
          fallbackForm.append("document", blob, att.filename || "attachment");
          fallbackForm.append("caption", markdownV2ToPlainText(caption));
          if (replyMarkup)
            fallbackForm.append("reply_markup", JSON.stringify(replyMarkup));
          const fallbackData = (await http
            .post(url, { body: fallbackForm })
            .json()) as {
            result: { message_id: number };
          };
          return fallbackData.result.message_id;
        }

        throw new Error(
          `TG sendDocument ${response.status}: ${errBody.description}`,
        );
      }
    } else {
      const textMsgId = await sendTextMessage(
        token,
        chatId,
        caption,
        replyMarkup,
      );

      const chunks: Attachment[][] = [];
      for (let i = 0; i < attachments.length; i += TG_MEDIA_GROUP_LIMIT) {
        chunks.push(attachments.slice(i, i + TG_MEDIA_GROUP_LIMIT));
      }
      for (const chunk of chunks) {
        await sendMediaGroupChunk(token, chatId, "", chunk, textMsgId);
      }
      return textMsgId;
    }
  } catch (e) {
    throw new Error(
      `发送附件消息异常: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** 编辑附件消息的 caption */
export async function editMessageCaption(
  token: string,
  chatId: string,
  messageId: number,
  caption: string,
  replyMarkup?: unknown,
): Promise<void> {
  const url = `${TG_API_BASE}${token}/editMessageCaption`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: "MarkdownV2",
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await tgPost(url, payload, "editMessageCaption");
}

/**
 * 置顶消息。幂等：已置顶或消息不存在时静默返回；其它错误（无权限等）抛出。
 * 默认 disable_notification=true，避免每次 ⭐ 都刷一条「已置顶」提示。
 */
export async function pinChatMessage(
  token: string,
  chatId: string,
  messageId: number,
): Promise<void> {
  const url = `${TG_API_BASE}${token}/pinChatMessage`;
  try {
    await tgPost(
      url,
      { chat_id: chatId, message_id: messageId, disable_notification: true },
      "pinChatMessage",
    );
  } catch (err) {
    if (err instanceof Error && /already pinned|not found/i.test(err.message))
      return;
    throw err;
  }
}

/** 取消置顶指定消息。幂等：未置顶或消息不存在时静默返回。 */
export async function unpinChatMessage(
  token: string,
  chatId: string,
  messageId: number,
): Promise<void> {
  const url = `${TG_API_BASE}${token}/unpinChatMessage`;
  try {
    await tgPost(
      url,
      { chat_id: chatId, message_id: messageId },
      "unpinChatMessage",
    );
  } catch (err) {
    if (err instanceof Error && /not found|not pinned/i.test(err.message))
      return;
    throw err;
  }
}

/** 设置/更新消息的 inline keyboard */
export async function setReplyMarkup(
  token: string,
  chatId: string,
  messageId: number,
  replyMarkup: unknown,
): Promise<void> {
  const url = `${TG_API_BASE}${token}/editMessageReplyMarkup`;
  await tgPost(
    url,
    { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup },
    "editMessageReplyMarkup",
  );
}

/** 删除消息（用于去重时撤回重复消息） */
/** 生成指向 Telegram 群组消息的深链接 */
export function buildTgMessageLink(chatId: string, messageId: number): string {
  const numericId = chatId.replace(/^-100/, "");
  return `https://t.me/c/${numericId}/${messageId}`;
}

export async function deleteMessage(
  token: string,
  chatId: string,
  messageId: number,
): Promise<void> {
  const url = `${TG_API_BASE}${token}/deleteMessage`;
  await tgPost(
    url,
    { chat_id: chatId, message_id: messageId },
    "deleteMessage",
  );
}

async function sendMediaGroupChunk(
  token: string,
  chatId: string,
  caption: string,
  attachments: Attachment[],
  replyToMessageId?: number,
): Promise<number> {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (replyToMessageId)
    form.append("reply_to_message_id", String(replyToMessageId));

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

  const url = `${TG_API_BASE}${token}/sendMediaGroup`;
  try {
    const data = (await http.post(url, { body: form }).json()) as {
      result: Array<{ message_id: number }>;
    };
    return data.result[0].message_id;
  } catch (err) {
    if (!(err instanceof HTTPError)) throw err;
    const { response } = err;

    const errBody = (await response.json()) as { description?: string };
    console.error("TG sendMediaGroup failed payload:", {
      chatId,
      captionLength: caption.length,
      attachments: attachments.length,
      description: errBody.description,
    });

    if (isEntityParseError(errBody.description) && caption) {
      console.warn(
        "TG sendMediaGroup parse_mode failed, retrying as plain caption",
      );
      const fallbackForm = new FormData();
      fallbackForm.append("chat_id", chatId);
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
      const fallbackData = (await http
        .post(url, { body: fallbackForm })
        .json()) as {
        result: Array<{ message_id: number }>;
      };
      return fallbackData.result[0].message_id;
    }

    throw new Error(
      `TG sendMediaGroup ${response.status}: ${errBody.description}`,
    );
  }
}
