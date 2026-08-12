import { describe, expect, it } from "vitest";
import { EmailMessageNotFoundError } from "../src/errors/email-provider";

describe("provider delivery errors", () => {
  it("retains the missing message context", () => {
    const notFound = new EmailMessageNotFoundError("message-1", "INBOX");

    expect(notFound).toMatchObject({
      folder: "INBOX",
      messageId: "message-1",
      name: "EmailMessageNotFoundError",
    });
  });
});
