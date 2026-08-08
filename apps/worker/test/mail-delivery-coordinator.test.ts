import { describe, expect, it } from "vitest";
import {
  coordinateEmailDelivery,
  type EmailDeliveryOperations,
  type EmailDeliveryResult,
} from "../src/utils/mail-delivery/coordinator";

type ClaimState = "pending" | "sending" | "retryable" | "unknown" | null;

class RetryableDeliveryError extends Error {}

interface DeliveryHarness {
  operations: EmailDeliveryOperations;
  getClaimState: () => ClaimState;
  getSendCount: () => number;
  setDelivered: (delivered: boolean) => void;
}

describe("email delivery coordinator", () => {
  it("allows only one of two concurrent attempts to send", async () => {
    let releaseSend = () => {};
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let signalSendStarted = () => {};
    const sendStarted = new Promise<void>((resolve) => {
      signalSendStarted = resolve;
    });
    const harness = createHarness(async (beforeSend) => {
      if (!(await beforeSend())) return "not-claimed";
      signalSendStarted();
      await sendReleased;
      harness.setDelivered(true);
      return "sent";
    });

    const first = coordinateEmailDelivery(harness.operations);
    await sendStarted;
    const second = await coordinateEmailDelivery(harness.operations);
    releaseSend();

    expect(await first).toBe("sent");
    expect(second).toBe("not-claimed");
    expect(harness.getSendCount()).toBe(1);
  });

  it("skips an existing mapping and clears its stale claim", async () => {
    const harness = createHarness(async () => "sent", {
      delivered: true,
      state: "unknown",
    });

    expect(await coordinateEmailDelivery(harness.operations)).toBe(
      "already-delivered",
    );
    expect(harness.getClaimState()).toBeNull();
    expect(harness.getSendCount()).toBe(0);
  });

  it("leaves a pre-claim failure pending for a later retry", async () => {
    const harness = createHarness(async () => {
      throw new Error("parse failed");
    });

    await expect(coordinateEmailDelivery(harness.operations)).rejects.toThrow(
      "parse failed",
    );
    expect(harness.getClaimState()).toBe("pending");
    expect(harness.getSendCount()).toBe(0);
  });

  it("marks a claimed failure unknown and refuses a later send", async () => {
    const harness = createHarness(async (beforeSend) => {
      if (!(await beforeSend())) return "not-claimed";
      throw new Error("network lost");
    });

    await expect(coordinateEmailDelivery(harness.operations)).rejects.toThrow(
      "network lost",
    );
    expect(harness.getClaimState()).toBe("unknown");
    expect(await coordinateEmailDelivery(harness.operations)).toBe(
      "not-claimed",
    );
    expect(harness.getSendCount()).toBe(1);
  });

  it("leaves a known retryable claimed failure available to the fallback scan", async () => {
    let attempts = 0;
    const harness = createHarness(
      async (beforeSend) => {
        if (!(await beforeSend())) return "not-claimed";
        attempts += 1;
        if (attempts === 1) throw new RetryableDeliveryError("rate limited");
        harness.setDelivered(true);
        return "sent";
      },
      {
        isRetryableError: (error) => error instanceof RetryableDeliveryError,
      },
    );

    await expect(coordinateEmailDelivery(harness.operations)).rejects.toThrow(
      "rate limited",
    );
    expect(harness.getClaimState()).toBe("retryable");
    expect(await coordinateEmailDelivery(harness.operations)).toBe("sent");
    expect(harness.getSendCount()).toBe(2);
  });

  it("removes the transient claim after a successful send", async () => {
    const harness = createHarness(async (beforeSend) => {
      if (!(await beforeSend())) return "not-claimed";
      harness.setDelivered(true);
      return "sent";
    });

    expect(await coordinateEmailDelivery(harness.operations)).toBe("sent");
    expect(harness.getClaimState()).toBeNull();
    expect(harness.getSendCount()).toBe(1);
  });
});

const createHarness = (
  deliver: (beforeSend: () => Promise<boolean>) => Promise<EmailDeliveryResult>,
  initial: {
    delivered?: boolean;
    state?: ClaimState;
    isRetryableError?: (error: unknown) => boolean;
  } = {},
): DeliveryHarness => {
  let delivered = initial.delivered ?? false;
  let state = initial.state ?? null;
  let sendCount = 0;

  const operations = {
    isDelivered: async () => delivered,
    ensurePending: async () => {
      state ??= "pending";
    },
    claim: async () => {
      if (state !== "pending" && state !== "retryable") return false;
      state = "sending";
      return true;
    },
    deliver: async (beforeSend: () => Promise<boolean>) => {
      const result = await deliver(async () => {
        const claimed = await beforeSend();
        if (claimed) sendCount += 1;
        return claimed;
      });
      return result;
    },
    isRetryableError: initial.isRetryableError ?? (() => false),
    markRetryable: async () => {
      if (state === "sending") state = "retryable";
    },
    markUnknown: async () => {
      if (state === "sending") state = "unknown";
    },
    clear: async () => {
      state = null;
    },
  };

  return {
    operations,
    getClaimState: () => state,
    getSendCount: () => sendCount,
    setDelivered: (value) => {
      delivered = value;
    },
  };
};
