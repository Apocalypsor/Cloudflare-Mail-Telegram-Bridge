import { describe, expect, it } from "vitest";
import { runTelegramFollowups } from "../src/clients/telegram";

describe("Telegram follow-up operations", () => {
  it("preserves the initial message id when a later attachment send fails", async () => {
    const followupError = new Error("media group rate limited");

    const result = await runTelegramFollowups(123, async () => {
      throw followupError;
    });

    expect(result?.messageId).toBe(123);
    expect(result?.followupError).toBe(followupError);
  });

  it("returns the initial message without an error after all follow-ups", async () => {
    const result = await runTelegramFollowups(124, async () => {});

    expect(result).toEqual({ messageId: 124 });
  });
});
