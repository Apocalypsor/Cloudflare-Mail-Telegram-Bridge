import type { TelegramRateLimitReason } from "@worker/durable-objects/telegram-rate-limiter";

export enum TelegramApiErrorCode {
  ChatUnavailable = "chat_unavailable",
  EntityParseFailed = "entity_parse_failed",
  MessageAlreadyPinned = "message_already_pinned",
  MessageDeletionUnavailable = "message_deletion_unavailable",
  MessageNotFound = "message_not_found",
  MessageNotModified = "message_not_modified",
  MessageNotPinned = "message_not_pinned",
  Unknown = "unknown",
}

export class TelegramApiError extends Error {
  readonly code: TelegramApiErrorCode;
  readonly description: string;
  readonly label: string;
  readonly status: number;

  constructor(
    label: string,
    status: number,
    description: string,
    cause?: unknown,
  ) {
    super(`TG ${label} ${status}: ${description}`, { cause });
    this.name = "TelegramApiError";
    this.code = classifyTelegramApiError(status, description);
    this.description = description;
    this.label = label;
    this.status = status;
  }
}

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

const classifyTelegramApiError = (
  status: number,
  description: string,
): TelegramApiErrorCode => {
  if (
    (status === 400 || status === 403) &&
    /blocked|kicked|deactivated|chat not found|chat_id is empty/i.test(
      description,
    )
  ) {
    return TelegramApiErrorCode.ChatUnavailable;
  }
  if (/can't parse entities/i.test(description)) {
    return TelegramApiErrorCode.EntityParseFailed;
  }
  if (/message is not modified/i.test(description)) {
    return TelegramApiErrorCode.MessageNotModified;
  }
  if (/already pinned/i.test(description)) {
    return TelegramApiErrorCode.MessageAlreadyPinned;
  }
  if (/not pinned/i.test(description)) {
    return TelegramApiErrorCode.MessageNotPinned;
  }
  if (
    /can't be deleted|cannot be deleted|not enough rights/i.test(description)
  ) {
    return TelegramApiErrorCode.MessageDeletionUnavailable;
  }
  if (/not found|MESSAGE_ID_INVALID|message to pin/i.test(description)) {
    return TelegramApiErrorCode.MessageNotFound;
  }
  return TelegramApiErrorCode.Unknown;
};
