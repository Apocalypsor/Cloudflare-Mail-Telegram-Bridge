import { mailController } from "@worker/api/modules/mail";
import { describe, expect, it } from "vitest";

describe("API controller isolation", () => {
  it("keeps the mail mutation resolver local to the mail controller", () => {
    const mailResolvers = mailController.event.beforeHandle?.filter(
      (hook) => hook.subType === "resolve",
    );

    expect(mailResolvers).toHaveLength(1);
    expect(mailResolvers?.[0]?.scope).toBe("local");
  });
});
