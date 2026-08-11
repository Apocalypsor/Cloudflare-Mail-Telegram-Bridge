import { sendTextMessage } from "@worker/clients/telegram";
import { TG_MSG_LIMIT } from "@worker/constants";
import type { Env } from "@worker/types";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Telegram text fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["ENTITIES_TOO_LONG", "message is too long"])(
    "retries %s as bounded plain text",
    async (description) => {
      const payloads: Record<string, unknown>[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          payloads.push(
            (await request.clone().json()) as Record<string, unknown>,
          );
          if (payloads.length === 1) {
            return Response.json(
              { ok: false, description: `Bad Request: ${description}` },
              { status: 400 },
            );
          }
          return Response.json({ ok: true, result: { message_id: 123 } });
        }),
      );

      const env = {
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_RATE_LIMITER: {
          getByName: () => ({ reserve: async () => ({ ok: true }) }),
        },
      } as Env;
      const text = `*[Open]* [link](https://example.com/${"x".repeat(5_000)})`;

      await expect(sendTextMessage(env, "42", text)).resolves.toBe(123);
      expect(payloads).toHaveLength(2);
      expect(payloads[1]).not.toHaveProperty("parse_mode");
      expect((payloads[1].text as string).length).toBeLessThanOrEqual(
        TG_MSG_LIMIT,
      );
    },
  );
});
