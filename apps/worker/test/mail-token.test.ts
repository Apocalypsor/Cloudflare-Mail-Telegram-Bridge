import { describe, expect, it } from "vitest";
import {
  buildMailPreviewUrl,
  parseMailPreviewAccess,
} from "../src/utils/mail/token";

describe("mail preview links", () => {
  it("uses one access query parameter so Rich HTML needs no ampersand entity", async () => {
    await expect(
      buildMailPreviewUrl("https://worker.example/", "secret", "message/1", 42),
    ).resolves.toBe(
      "https://worker.example/api/mail/message%2F1/open?access=42.e862bb796d05b826e5943624303386f1",
    );
  });

  it("decodes a valid preview access value", () => {
    expect(
      parseMailPreviewAccess("42.e862bb796d05b826e5943624303386f1"),
    ).toEqual({
      accountId: 42,
      token: "e862bb796d05b826e5943624303386f1",
    });
  });

  it("rejects malformed preview access values", () => {
    expect(parseMailPreviewAccess("missing-token")).toBeNull();
    expect(parseMailPreviewAccess("0.token")).toBeNull();
    expect(parseMailPreviewAccess("account.token.extra")).toBeNull();
  });
});
