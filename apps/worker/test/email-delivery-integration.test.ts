import { env } from "cloudflare:workers";
import { HTTPError } from "ky";
import { beforeEach, describe, expect, it } from "vitest";
import {
  isTelegramRateLimitError,
  runTelegramFollowups,
  TelegramRateLimitError,
} from "../src/clients/telegram";
import {
  claimEmailDelivery,
  deleteEmailDelivery,
  ensureEmailDeliveryPending,
  getEmailDeliveryState,
  markEmailDeliveryRetryable,
  markEmailDeliveryUnknown,
} from "../src/db/email-deliveries";
import {
  getMappingsByEmailIds,
  putMessageMapping,
} from "../src/db/message-map";
import {
  coordinateEmailDelivery,
  type EmailDeliveryOperations,
  type EmailDeliveryResult,
  runAfterDeliveryClaim,
} from "../src/utils/mail-delivery/coordinator";
import {
  clearMissingEmailDelivery,
  getEmailDeliveryFailureContext,
} from "../src/utils/mail-delivery/dispatch";

type InjectedDelivery = (
  beforeSend: () => Promise<boolean>,
) => Promise<EmailDeliveryResult>;

describe("persisted email delivery safety boundary", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM email_deliveries"),
      env.DB.prepare("DELETE FROM message_map"),
      env.DB.prepare("DELETE FROM accounts WHERE id = 1"),
      env.DB.prepare("INSERT INTO accounts (id, chat_id) VALUES (?, ?)").bind(
        1,
        "chat-1",
      ),
    ]);
  });

  it("claims in D1 before invoking the injected Telegram send", async () => {
    await ensureEmailDeliveryPending(env.DB, 1, "message-1");
    let telegramCalls = 0;
    let stateAtSend: string | null = null;

    const result = await runAfterDeliveryClaim(
      () => claimEmailDelivery(env.DB, 1, "message-1"),
      async () => {
        telegramCalls += 1;
        stateAtSend = await getEmailDeliveryState(env.DB, 1, "message-1");
        return 123;
      },
    );

    expect(result).toEqual({ claimed: true, value: 123 });
    expect(telegramCalls).toBe(1);
    expect(stateAtSend).toBe("sending");
  });

  it("allows one concurrent send and keeps the mapping before claim cleanup", async () => {
    let releaseSend = () => {};
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let signalSendStarted = () => {};
    const sendStarted = new Promise<void>((resolve) => {
      signalSendStarted = resolve;
    });
    let telegramCalls = 0;
    let mappingVisibleBeforeClear = false;
    const deliver: InjectedDelivery = async (beforeSend) => {
      const initialSend = await runAfterDeliveryClaim(beforeSend, async () => {
        telegramCalls += 1;
        signalSendStarted();
        await sendReleased;
        return 201;
      });
      if (!initialSend.claimed) return "not-claimed";
      await putMessageMapping(env.DB, {
        account_id: 1,
        email_message_id: "message-2",
        tg_chat_id: "chat-1",
        tg_message_id: initialSend.value,
      });
      return "sent";
    };
    const operations = () =>
      createPersistedOperations("message-2", deliver, async () => {
        mappingVisibleBeforeClear = await hasMapping("message-2");
      });

    const first = coordinateEmailDelivery(operations());
    await sendStarted;
    const second = await coordinateEmailDelivery(operations());
    releaseSend();

    expect(await first).toBe("sent");
    expect(second).toBe("not-claimed");
    expect(telegramCalls).toBe(1);
    expect(mappingVisibleBeforeClear).toBe(true);
    expect(await hasMapping("message-2")).toBe(true);
    expect(await getEmailDeliveryState(env.DB, 1, "message-2")).toBeNull();
  });

  it("persists a rate-limited send as retryable and later delivers it", async () => {
    let attempts = 0;
    const deliver: InjectedDelivery = async (beforeSend) => {
      const initialSend = await runAfterDeliveryClaim(beforeSend, async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new TelegramRateLimitError("sendMessage", 1, "blocked");
        }
        return 202;
      });
      if (!initialSend.claimed) return "not-claimed";
      await putMessageMapping(env.DB, {
        account_id: 1,
        email_message_id: "message-3",
        tg_chat_id: "chat-1",
        tg_message_id: initialSend.value,
      });
      return "sent";
    };

    await expect(
      coordinateEmailDelivery(createPersistedOperations("message-3", deliver)),
    ).rejects.toThrow(TelegramRateLimitError);
    expect(await getEmailDeliveryState(env.DB, 1, "message-3")).toBe(
      "retryable",
    );

    expect(
      await coordinateEmailDelivery(
        createPersistedOperations("message-3", deliver),
      ),
    ).toBe("sent");
    expect(attempts).toBe(2);
    expect(await hasMapping("message-3")).toBe(true);
  });

  it("persists an ambiguous claimed failure as unknown and never resends it", async () => {
    let telegramCalls = 0;
    const deliver: InjectedDelivery = async (beforeSend) => {
      const initialSend = await runAfterDeliveryClaim(beforeSend, async () => {
        telegramCalls += 1;
        throw new Error("connection lost");
      });
      return initialSend.claimed ? "sent" : "not-claimed";
    };
    const operations = () => createPersistedOperations("message-4", deliver);

    await expect(coordinateEmailDelivery(operations())).rejects.toThrow(
      "connection lost",
    );
    expect(await getEmailDeliveryState(env.DB, 1, "message-4")).toBe("unknown");
    expect(await coordinateEmailDelivery(operations())).toBe("not-claimed");
    expect(telegramCalls).toBe(1);
    expect(await hasMapping("message-4")).toBe(false);
  });

  it("keeps the mapping when a later attachment operation is rate limited", async () => {
    let telegramCalls = 0;
    const deliver: InjectedDelivery = async (beforeSend) => {
      const initialSend = await runAfterDeliveryClaim(beforeSend, async () => {
        telegramCalls += 1;
        return runTelegramFollowups(204, async () => {
          throw new TelegramRateLimitError("sendMediaGroup", 1, "blocked");
        });
      });
      if (!initialSend.claimed) return "not-claimed";
      expect(initialSend.value.followupError).toBeInstanceOf(
        TelegramRateLimitError,
      );
      await putMessageMapping(env.DB, {
        account_id: 1,
        email_message_id: "message-5",
        tg_chat_id: "chat-1",
        tg_message_id: initialSend.value.messageId,
      });
      return "sent";
    };
    const operations = () => createPersistedOperations("message-5", deliver);

    expect(await coordinateEmailDelivery(operations())).toBe("sent");
    expect(await hasMapping("message-5")).toBe(true);
    expect(await getEmailDeliveryState(env.DB, 1, "message-5")).toBeNull();
    expect(await coordinateEmailDelivery(operations())).toBe(
      "already-delivered",
    );
    expect(telegramCalls).toBe(1);
  });

  it("clears a pending claim when Gmail or Outlook reports HTTP 404", async () => {
    await ensureEmailDeliveryPending(env.DB, 1, "message-6");
    const notFound = new HTTPError(
      new Response(null, { status: 404 }),
      new Request("https://provider.example/messages/missing"),
      {} as never,
    );

    const cleared = await clearMissingEmailDelivery(
      env.DB,
      1,
      "message-6",
      notFound,
    );

    expect(cleared).toBe(true);
    expect(await getEmailDeliveryState(env.DB, 1, "message-6")).toBeNull();
  });

  it("reads claim and mapping state for delivery failure observability", async () => {
    await ensureEmailDeliveryPending(env.DB, 1, "message-7");
    await putMessageMapping(env.DB, {
      account_id: 1,
      email_message_id: "message-7",
      tg_chat_id: "chat-1",
      tg_message_id: 207,
    });
    const context = await getEmailDeliveryFailureContext(
      env.DB,
      1,
      "message-7",
    );

    expect(context).toEqual({ claimState: "pending", hasMapping: true });
  });
});

const createPersistedOperations = (
  emailMessageId: string,
  deliver: InjectedDelivery,
  beforeClear?: () => Promise<void>,
): EmailDeliveryOperations => ({
  isDelivered: () => hasMapping(emailMessageId),
  ensurePending: () => ensureEmailDeliveryPending(env.DB, 1, emailMessageId),
  claim: () => claimEmailDelivery(env.DB, 1, emailMessageId),
  deliver,
  isRetryableError: isTelegramRateLimitError,
  markRetryable: () => markEmailDeliveryRetryable(env.DB, 1, emailMessageId),
  markUnknown: () => markEmailDeliveryUnknown(env.DB, 1, emailMessageId),
  clear: async () => {
    await beforeClear?.();
    await deleteEmailDelivery(env.DB, 1, emailMessageId);
  },
});

const hasMapping = async (emailMessageId: string): Promise<boolean> =>
  (await getMappingsByEmailIds(env.DB, 1, [emailMessageId])).length > 0;
