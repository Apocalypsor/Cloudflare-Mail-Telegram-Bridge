import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimEmailDelivery,
  deleteEmailDeliveriesByAccountId,
  ensureEmailDeliveryPending,
  getEmailDeliveryState,
  markEmailDeliveryRetryable,
  markEmailDeliveryUnknown,
  markStaleEmailDeliveriesUnknown,
} from "../src/db/email-deliveries";

interface DeliveryStateRow {
  state: string;
}

describe("email delivery claims", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM email_deliveries"),
      env.DB.prepare("DELETE FROM accounts WHERE id IN (1, 2)"),
      env.DB.prepare("INSERT INTO accounts (id, chat_id) VALUES (?, ?)").bind(
        1,
        "chat-1",
      ),
      env.DB.prepare("INSERT INTO accounts (id, chat_id) VALUES (?, ?)").bind(
        2,
        "chat-2",
      ),
    ]);
  });

  it("allows only one concurrent claimant for the same email", async () => {
    await ensureEmailDeliveryPending(env.DB, 1, "message-1");

    const claims = await Promise.all([
      claimEmailDelivery(env.DB, 1, "message-1"),
      claimEmailDelivery(env.DB, 1, "message-1"),
    ]);

    expect(claims.sort()).toEqual([false, true]);
  });

  it("does not reset an unknown delivery when another signal arrives", async () => {
    await ensureEmailDeliveryPending(env.DB, 1, "message-2");
    expect(await claimEmailDelivery(env.DB, 1, "message-2")).toBe(true);
    await markEmailDeliveryUnknown(env.DB, 1, "message-2");

    await ensureEmailDeliveryPending(env.DB, 1, "message-2");

    expect(await readState(1, "message-2")).toBe("unknown");
    expect(await claimEmailDelivery(env.DB, 1, "message-2")).toBe(false);
  });

  it("allows a retryable delivery to be claimed again", async () => {
    await ensureEmailDeliveryPending(env.DB, 1, "message-3");
    expect(await claimEmailDelivery(env.DB, 1, "message-3")).toBe(true);
    await markEmailDeliveryRetryable(env.DB, 1, "message-3");

    expect(await claimEmailDelivery(env.DB, 1, "message-3")).toBe(true);
  });

  it("deletes every outstanding delivery for an account", async () => {
    await ensureEmailDeliveryPending(env.DB, 1, "message-4");
    await ensureEmailDeliveryPending(env.DB, 1, "message-5");
    await ensureEmailDeliveryPending(env.DB, 2, "message-6");

    await deleteEmailDeliveriesByAccountId(env.DB, 1);

    expect(await readState(1, "message-4")).toBeNull();
    expect(await readState(1, "message-5")).toBeNull();
    expect(await readState(2, "message-6")).toBe("pending");
  });

  it("does not claim delivery after its account is disabled", async () => {
    await ensureEmailDeliveryPending(env.DB, 1, "message-7");
    await env.DB.prepare("UPDATE accounts SET disabled = 1 WHERE id = 1").run();

    expect(await claimEmailDelivery(env.DB, 1, "message-7")).toBe(false);
    expect(await readState(1, "message-7")).toBe("pending");
  });

  it("deletes outstanding delivery state with its account", async () => {
    await ensureEmailDeliveryPending(env.DB, 1, "message-8");

    await env.DB.prepare("DELETE FROM accounts WHERE id = 1").run();

    expect(await readState(1, "message-8")).toBeNull();
  });

  it("reads the persisted delivery state for failure diagnostics", async () => {
    await ensureEmailDeliveryPending(env.DB, 1, "message-9");

    expect(await getEmailDeliveryState(env.DB, 1, "message-9")).toBe("pending");
  });

  it("turns a stale sending claim into conservative unknown state", async () => {
    await ensureEmailDeliveryPending(env.DB, 1, "message-10");
    expect(await claimEmailDelivery(env.DB, 1, "message-10")).toBe(true);
    await env.DB.prepare(
      "UPDATE email_deliveries SET updated_at = 0 WHERE account_id = 1 AND email_message_id = 'message-10'",
    ).run();
    const changed = await markStaleEmailDeliveriesUnknown(env.DB, new Date(1));

    expect(changed).toBe(1);
    expect(await readState(1, "message-10")).toBe("unknown");
  });
});

describe("failed email schema", () => {
  it("uses only the Rich HTML message model", async () => {
    const columns = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('failed_emails') ORDER BY cid",
    ).all<{ name: string }>();

    expect(columns.results.map((column) => column.name)).toEqual([
      "id",
      "account_id",
      "email_message_id",
      "tg_chat_id",
      "tg_message_id",
      "subject",
      "error_message",
      "created_at",
    ]);
  });
});

const readState = async (
  accountId: number,
  emailMessageId: string,
): Promise<string | null> => {
  const row = await env.DB.prepare(
    "SELECT state FROM email_deliveries WHERE account_id = ? AND email_message_id = ?",
  )
    .bind(accountId, emailMessageId)
    .first<DeliveryStateRow>();
  return row?.state ?? null;
};
