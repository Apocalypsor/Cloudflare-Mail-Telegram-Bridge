export type EmailDeliveryResult = "sent" | "skipped" | "not-claimed";

export type EmailDeliveryOutcome = EmailDeliveryResult | "already-delivered";

export type DeliveryClaimResult<T> =
  | { claimed: false }
  | { claimed: true; value: T };

export interface EmailDeliveryOperations {
  isDelivered: () => Promise<boolean>;
  ensurePending: () => Promise<void>;
  claim: () => Promise<boolean>;
  deliver: (beforeSend: () => Promise<boolean>) => Promise<EmailDeliveryResult>;
  isRetryableError: (error: unknown) => boolean;
  markRetryable: () => Promise<void>;
  markUnknown: () => Promise<void>;
  clear: () => Promise<void>;
}

export const runAfterDeliveryClaim = async <T>(
  claim: (() => Promise<boolean>) | undefined,
  operation: () => Promise<T>,
): Promise<DeliveryClaimResult<T>> => {
  if (claim && !(await claim())) return { claimed: false };
  return { claimed: true, value: await operation() };
};

export const coordinateEmailDelivery = async (
  operations: EmailDeliveryOperations,
): Promise<EmailDeliveryOutcome> => {
  if (await operations.isDelivered()) {
    await operations.clear();
    return "already-delivered";
  }

  await operations.ensurePending();
  let claimed = false;

  try {
    const result = await operations.deliver(async () => {
      claimed = await operations.claim();
      return claimed;
    });
    if (result === "sent" || result === "skipped") {
      await operations.clear();
    }
    return result;
  } catch (error) {
    const delivered = await operations.isDelivered().catch(() => false);
    if (delivered) {
      await operations.clear();
    } else if (claimed) {
      if (operations.isRetryableError(error)) {
        await operations.markRetryable();
      } else {
        await operations.markUnknown();
      }
    }
    throw error;
  }
};
