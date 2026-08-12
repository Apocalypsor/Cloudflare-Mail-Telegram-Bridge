import { describe, expect, it } from "vitest";
import {
  TelegramApiError,
  TelegramApiErrorCode,
  TelegramRateLimitError,
} from "../src/errors/telegram";

describe("Telegram errors", () => {
  it.each([
    ["Bad Request: chat not found", TelegramApiErrorCode.ChatUnavailable],
    [
      "Forbidden: bot was blocked by the user",
      TelegramApiErrorCode.ChatUnavailable,
    ],
    [
      "Bad Request: can't parse entities",
      TelegramApiErrorCode.EntityParseFailed,
    ],
    [
      "Bad Request: message is not modified",
      TelegramApiErrorCode.MessageNotModified,
    ],
    [
      "Bad Request: message is already pinned",
      TelegramApiErrorCode.MessageAlreadyPinned,
    ],
    [
      "Bad Request: message is not pinned",
      TelegramApiErrorCode.MessageNotPinned,
    ],
    [
      "Bad Request: message to delete not found",
      TelegramApiErrorCode.MessageNotFound,
    ],
    [
      "Bad Request: message can't be deleted",
      TelegramApiErrorCode.MessageDeletionUnavailable,
    ],
    ["Bad Request: something else", TelegramApiErrorCode.Unknown],
  ] as const)("classifies %s", (description, code) => {
    expect(new TelegramApiError("sendMessage", 400, description).code).toBe(
      code,
    );
  });

  it("retains rate-limit retry context", () => {
    expect(
      new TelegramRateLimitError("sendMessage", 3, "blocked"),
    ).toMatchObject({
      delaySeconds: 3,
      label: "sendMessage",
      name: "TelegramRateLimitError",
      reason: "blocked",
    });
  });
});
