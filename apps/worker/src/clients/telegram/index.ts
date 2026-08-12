import type {
  DeleteMessageResult,
  PinResult,
  TelegramClientEnv,
  TelegramSendResult,
} from "@worker/clients/telegram/types";
import {
  postTelegramForm,
  postTelegramJson,
} from "@worker/clients/telegram/utils/api";
import { attachmentToBlob } from "@worker/clients/telegram/utils/attachment";
import { TG_MEDIA_GROUP_LIMIT } from "@worker/constants";
import {
  TelegramApiError,
  TelegramApiErrorCode,
  TelegramRateLimitError,
} from "@worker/errors/telegram";
import type { Attachment } from "@worker/types";

export type { TelegramSendResult } from "@worker/clients/telegram/types";

export class TelegramClient {
  constructor(private readonly env: TelegramClientEnv) {}

  static buildMessageLink(
    chatId: string,
    messageId: number,
    messageThreadId?: number | null,
  ): string {
    const numericId = chatId.replace(/^-100/, "");
    if (messageThreadId != null) {
      return `https://t.me/c/${numericId}/${messageThreadId}/${messageId}`;
    }
    return `https://t.me/c/${numericId}/${messageId}`;
  }

  static async runFollowups(
    messageId: number,
    operation: () => Promise<void>,
  ): Promise<TelegramSendResult> {
    try {
      await operation();
      return { messageId };
    } catch (followupError) {
      return { messageId, followupError };
    }
  }

  async sendTextMessage(
    chatId: string,
    text: string,
    replyMarkup?: unknown,
    extras?: Record<string, unknown>,
  ): Promise<number> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      ...extras,
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const data = await postTelegramJson<{ message_id: number }>(
      this.env,
      chatId,
      "sendMessage",
      payload,
    );
    return data.message_id;
  }

  async sendRichMessage(
    chatId: string,
    html: string,
    replyMarkup?: unknown,
    messageThreadId?: number | null,
  ): Promise<number> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      rich_message: { html },
    };
    if (messageThreadId != null) payload.message_thread_id = messageThreadId;
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const data = await postTelegramJson<{ message_id: number }>(
      this.env,
      chatId,
      "sendRichMessage",
      payload,
    );
    return data.message_id;
  }

  async editRichMessage(
    chatId: string,
    messageId: number,
    html: string,
    replyMarkup?: unknown,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      rich_message: { html },
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await postTelegramJson(this.env, chatId, "editMessageText", payload);
  }

  async sendWithAttachments(
    chatId: string,
    html: string,
    attachments: Attachment[],
    replyMarkup?: unknown,
    messageThreadId?: number | null,
  ): Promise<TelegramSendResult> {
    const messageId = await this.sendRichMessage(
      chatId,
      html,
      replyMarkup,
      messageThreadId,
    );

    return TelegramClient.runFollowups(messageId, async () => {
      for (let i = 0; i < attachments.length; i += TG_MEDIA_GROUP_LIMIT) {
        await this.sendAttachmentChunk(
          chatId,
          attachments.slice(i, i + TG_MEDIA_GROUP_LIMIT),
          messageId,
          messageThreadId,
        );
      }
    });
  }

  async pinChatMessage(chatId: string, messageId: number): Promise<PinResult> {
    try {
      await postTelegramJson(this.env, chatId, "pinChatMessage", {
        chat_id: chatId,
        message_id: messageId,
        disable_notification: true,
      });
      return "ok";
    } catch (error) {
      if (error instanceof TelegramRateLimitError) return "rate_limited";
      if (error instanceof TelegramApiError) {
        if (error.code === TelegramApiErrorCode.MessageAlreadyPinned) {
          return "ok";
        }
        if (
          error.code === TelegramApiErrorCode.MessageNotFound ||
          error.code === TelegramApiErrorCode.ChatUnavailable
        ) {
          return "not_found";
        }
      }
      throw error;
    }
  }

  async unpinChatMessage(chatId: string, messageId: number): Promise<void> {
    try {
      await postTelegramJson(this.env, chatId, "unpinChatMessage", {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (error) {
      if (error instanceof TelegramRateLimitError) return;
      if (
        error instanceof TelegramApiError &&
        (error.code === TelegramApiErrorCode.MessageNotFound ||
          error.code === TelegramApiErrorCode.MessageNotPinned ||
          error.code === TelegramApiErrorCode.ChatUnavailable)
      ) {
        return;
      }
      throw error;
    }
  }

  async setReplyMarkup(
    chatId: string,
    messageId: number,
    replyMarkup: unknown,
  ): Promise<void> {
    await postTelegramJson(this.env, chatId, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await postTelegramJson(this.env, chatId, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  async deleteMessageIfPresent(
    chatId: string,
    messageId: number,
  ): Promise<DeleteMessageResult> {
    try {
      await this.deleteMessage(chatId, messageId);
      return "deleted";
    } catch (error) {
      if (error instanceof TelegramRateLimitError) return "rate_limited";
      if (error instanceof TelegramApiError) {
        if (
          error.code === TelegramApiErrorCode.MessageNotFound ||
          error.code === TelegramApiErrorCode.ChatUnavailable
        ) {
          return "not_found";
        }
        if (error.code === TelegramApiErrorCode.MessageDeletionUnavailable) {
          return "unavailable";
        }
      }
      throw error;
    }
  }

  private async sendAttachmentChunk(
    chatId: string,
    attachments: Attachment[],
    replyToMessageId: number,
    messageThreadId?: number | null,
  ): Promise<void> {
    const form = new FormData();
    form.append("chat_id", chatId);
    if (messageThreadId != null) {
      form.append("message_thread_id", String(messageThreadId));
    }
    form.append(
      "reply_parameters",
      JSON.stringify({ message_id: replyToMessageId }),
    );

    if (attachments.length === 1) {
      const attachment = attachments[0];
      form.append(
        "document",
        attachmentToBlob(attachment),
        attachment.filename || "attachment",
      );
      await postTelegramForm(this.env, chatId, "sendDocument", form);
      return;
    }

    const media = attachments.map((attachment, index) => {
      const fieldName = `file${index}`;
      form.append(
        fieldName,
        attachmentToBlob(attachment),
        attachment.filename || `attachment_${index + 1}`,
      );
      return { type: "document", media: `attach://${fieldName}` };
    });
    form.append("media", JSON.stringify(media));

    try {
      await postTelegramForm(this.env, chatId, "sendMediaGroup", form);
    } catch (error) {
      if (!(error instanceof TelegramApiError)) throw error;
      console.error("TG sendMediaGroup failed payload:", {
        chatId,
        attachments: attachments.length,
        description: error.description,
      });
      throw error;
    }
  }
}
