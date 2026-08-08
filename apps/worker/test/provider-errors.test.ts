import { HTTPError } from "ky";
import { describe, expect, it } from "vitest";
import { isEmailMessageNotFound } from "../src/providers/errors";

describe("provider delivery errors", () => {
  it("treats a provider HTTP 404 as a stale email notification", () => {
    const notFound = new HTTPError(
      new Response(null, { status: 404 }),
      new Request("https://provider.example/messages/missing"),
      {} as never,
    );

    expect(isEmailMessageNotFound(notFound)).toBe(true);
  });

  it("does not discard transient provider HTTP failures", () => {
    const unavailable = new HTTPError(
      new Response(null, { status: 503 }),
      new Request("https://provider.example/messages/temporary"),
      {} as never,
    );

    expect(isEmailMessageNotFound(unavailable)).toBe(false);
  });
});
