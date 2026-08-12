import type { Env } from "@worker/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runTelegramFollowups,
  sendWithAttachments,
} from "../src/clients/telegram";

describe("Telegram follow-up operations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("sends Rich HTML first and a single attachment as its reply", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return Response.json({
          ok: true,
          result: { message_id: requests.length === 1 ? 123 : 124 },
        });
      }),
    );
    const env = {
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_RATE_LIMITER: {
        getByName: () => ({ reserve: async () => ({ ok: true }) }),
      },
    } as Env;

    await expect(
      sendWithAttachments(
        env,
        "42",
        "<p>Hello &amp; welcome</p>",
        [{ filename: "hello.txt", mimeType: "text/plain", content: "hello" }],
        { inline_keyboard: [] },
        7,
      ),
    ).resolves.toEqual({ messageId: 123 });

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/bottest-token/sendRichMessage",
      "/bottest-token/sendDocument",
    ]);
    await expect(requests[0].json()).resolves.toMatchObject({
      chat_id: "42",
      message_thread_id: 7,
      rich_message: { html: "<p>Hello &amp; welcome</p>" },
    });
    const attachment = await requests[1].formData();
    expect(attachment.get("reply_parameters")).toBe(
      JSON.stringify({ message_id: 123 }),
    );
    expect(attachment.get("message_thread_id")).toBe("7");
  });
});
