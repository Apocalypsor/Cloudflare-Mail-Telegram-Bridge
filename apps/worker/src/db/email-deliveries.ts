import { getDb } from "@worker/db/client";
import { accounts, emailDeliveries } from "@worker/db/schema";
import { and, eq, exists, inArray, lt } from "drizzle-orm";

export type EmailDeliveryState = (typeof emailDeliveries.$inferSelect)["state"];

export const ensureEmailDeliveryPending = async (
  d1: D1Database,
  accountId: number,
  emailMessageId: string,
): Promise<void> => {
  const db = getDb(d1);
  await db
    .insert(emailDeliveries)
    .values({
      account_id: accountId,
      email_message_id: emailMessageId,
      state: "pending",
    })
    .onConflictDoNothing();
};

export const getEmailDeliveryState = async (
  d1: D1Database,
  accountId: number,
  emailMessageId: string,
): Promise<EmailDeliveryState | null> => {
  const db = getDb(d1);
  const [row] = await db
    .select({ state: emailDeliveries.state })
    .from(emailDeliveries)
    .where(
      and(
        eq(emailDeliveries.account_id, accountId),
        eq(emailDeliveries.email_message_id, emailMessageId),
      ),
    );
  return row?.state ?? null;
};

export const claimEmailDelivery = async (
  d1: D1Database,
  accountId: number,
  emailMessageId: string,
): Promise<boolean> => {
  const db = getDb(d1);
  const result = await db
    .update(emailDeliveries)
    .set({ state: "sending", updated_at: new Date() })
    .where(
      and(
        eq(emailDeliveries.account_id, accountId),
        eq(emailDeliveries.email_message_id, emailMessageId),
        inArray(emailDeliveries.state, ["pending", "retryable"]),
        exists(
          db
            .select({ id: accounts.id })
            .from(accounts)
            .where(and(eq(accounts.id, accountId), eq(accounts.disabled, 0))),
        ),
      ),
    );
  return (result.meta?.changes ?? 0) > 0;
};

export const markEmailDeliveryRetryable = async (
  d1: D1Database,
  accountId: number,
  emailMessageId: string,
): Promise<void> => {
  await updateSendingState(d1, accountId, emailMessageId, "retryable");
};

export const markEmailDeliveryUnknown = async (
  d1: D1Database,
  accountId: number,
  emailMessageId: string,
): Promise<void> => {
  await updateSendingState(d1, accountId, emailMessageId, "unknown");
};

export const deleteEmailDelivery = async (
  d1: D1Database,
  accountId: number,
  emailMessageId: string,
): Promise<void> => {
  const db = getDb(d1);
  await db
    .delete(emailDeliveries)
    .where(
      and(
        eq(emailDeliveries.account_id, accountId),
        eq(emailDeliveries.email_message_id, emailMessageId),
      ),
    );
};

export const deleteEmailDeliveriesByAccountId = async (
  d1: D1Database,
  accountId: number,
): Promise<void> => {
  const db = getDb(d1);
  await db
    .delete(emailDeliveries)
    .where(eq(emailDeliveries.account_id, accountId));
};

export const markStaleEmailDeliveriesUnknown = async (
  d1: D1Database,
  staleBefore: Date,
): Promise<number> => {
  const db = getDb(d1);
  const result = await db
    .update(emailDeliveries)
    .set({ state: "unknown", updated_at: new Date() })
    .where(
      and(
        eq(emailDeliveries.state, "sending"),
        lt(emailDeliveries.updated_at, staleBefore),
      ),
    );
  return result.meta?.changes ?? 0;
};

const updateSendingState = async (
  d1: D1Database,
  accountId: number,
  emailMessageId: string,
  state: "retryable" | "unknown",
): Promise<void> => {
  const db = getDb(d1);
  await db
    .update(emailDeliveries)
    .set({ state, updated_at: new Date() })
    .where(
      and(
        eq(emailDeliveries.account_id, accountId),
        eq(emailDeliveries.email_message_id, emailMessageId),
        eq(emailDeliveries.state, "sending"),
      ),
    );
};
