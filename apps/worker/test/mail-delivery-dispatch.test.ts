import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmailDeliveryScheduleContext,
  type EmailDeliveryRequest,
  reserveEmailDeliveryRequests,
  runEmailDeliveryBatch,
} from "../src/utils/mail-delivery/dispatch";

describe("direct email delivery batches", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("processes a repeated account and email key only once", async () => {
    const processed: string[] = [];
    const requests: EmailDeliveryRequest[] = [
      { accountId: 1, emailMessageId: "same" },
      { accountId: 1, emailMessageId: "same" },
      { accountId: 2, emailMessageId: "same" },
      { accountId: 1, emailMessageId: "other" },
    ];

    const count = await runEmailDeliveryBatch(requests, async (request) => {
      processed.push(`${request.accountId}:${request.emailMessageId}`);
    });

    expect(count).toBe(3);
    expect(processed).toEqual(["1:same", "2:same", "1:other"]);
  });

  it("waits for each delivery before starting the next one", async () => {
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];

    await runEmailDeliveryBatch(
      [
        { accountId: 1, emailMessageId: "first" },
        { accountId: 1, emailMessageId: "second" },
      ],
      async ({ emailMessageId }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        order.push(`start:${emailMessageId}`);
        await Promise.resolve();
        order.push(`end:${emailMessageId}`);
        active -= 1;
      },
    );

    expect(maximumActive).toBe(1);
    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });

  it("does not start more deliveries than the invocation limit", async () => {
    const processed: string[] = [];

    const count = await runEmailDeliveryBatch(
      [
        { accountId: 1, emailMessageId: "first" },
        { accountId: 1, emailMessageId: "second" },
        { accountId: 1, emailMessageId: "third" },
      ],
      async ({ emailMessageId }) => {
        processed.push(emailMessageId);
      },
      { deadlineMs: Number.POSITIVE_INFINITY, maxItems: 2 },
    );

    expect(count).toBe(2);
    expect(processed).toEqual(["first", "second"]);
  });

  it("stops before claiming another email after its deadline", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const processed: string[] = [];

    const count = await runEmailDeliveryBatch(
      [
        { accountId: 1, emailMessageId: "first" },
        { accountId: 1, emailMessageId: "second" },
      ],
      async ({ emailMessageId }) => {
        processed.push(emailMessageId);
        now = 2_000;
      },
      { deadlineMs: 1_500, maxItems: 10 },
    );

    expect(count).toBe(1);
    expect(processed).toEqual(["first"]);
  });

  it("shares one ten-email limit across batches in the same invocation", () => {
    const context = createEmailDeliveryScheduleContext();
    const firstBatch = Array.from({ length: 7 }, (_, index) => ({
      accountId: 1,
      emailMessageId: `first-${index}`,
    }));
    const secondBatch = Array.from({ length: 7 }, (_, index) => ({
      accountId: 2,
      emailMessageId: `second-${index}`,
    }));

    const first = reserveEmailDeliveryRequests(firstBatch, context);
    const second = reserveEmailDeliveryRequests(secondBatch, context);

    expect(first?.length).toBe(7);
    expect(second?.length).toBe(3);
    expect(context.remaining).toBe(0);
  });
});
