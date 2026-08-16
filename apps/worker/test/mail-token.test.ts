import { describe, expect, it } from "vitest";
import {
  buildWebMailUrl,
  parseMailPreviewCredentials,
} from "../src/utils/mail/token";

describe("mail preview links", () => {
  it("uses one access query parameter for generated web mail URLs", () => {
    expect(
      buildWebMailUrl("https://worker.example/", "message/1", 42, "token"),
    ).toBe("https://worker.example/mail/message%2F1?access=42.token");
  });

  it("decodes a valid preview access value", () => {
    expect(
      parseMailPreviewCredentials({
        access: "42.e862bb796d05b826e5943624303386f1",
      }),
    ).toEqual({
      accountId: 42,
      token: "e862bb796d05b826e5943624303386f1",
    });
  });

  it("rejects malformed preview access values", () => {
    expect(parseMailPreviewCredentials({ access: "missing-token" })).toBeNull();
    expect(parseMailPreviewCredentials({ access: "0.token" })).toBeNull();
    expect(
      parseMailPreviewCredentials({ access: "account.token.extra" }),
    ).toBeNull();
  });

  it("accepts both compact and legacy credentials", () => {
    expect(parseMailPreviewCredentials({ access: "42.token" })).toEqual({
      accountId: 42,
      token: "token",
    });
    expect(
      parseMailPreviewCredentials({ accountId: "42", token: "token" }),
    ).toEqual({
      accountId: "42",
      token: "token",
    });
  });
});
