import { getAccountById } from "@worker/db/accounts";
import {
  claimEmailDelivery,
  deleteEmailDelivery,
  type EmailDeliveryState,
  ensureEmailDeliveryPending,
  getEmailDeliveryState,
  markEmailDeliveryRetryable,
  markEmailDeliveryUnknown,
  markStaleEmailDeliveriesUnknown,
} from "@worker/db/email-deliveries";
import { getMappingsByEmailIds } from "@worker/db/message-map";
import { EmailMessageNotFoundError } from "@worker/errors/email-provider";
import { TelegramRateLimitError } from "@worker/errors/telegram";
import { getEmailProvider } from "@worker/providers";
import type { EmailProvider } from "@worker/providers/base";
import type { Account, Env, WaitUntil } from "@worker/types";
import { coordinateEmailDelivery } from "@worker/utils/mail-delivery/coordinator";
import { deliverEmailToTelegram } from "@worker/utils/mail-delivery/deliver";
import { reportErrorToObservability } from "@worker/utils/observability";
import { utf8Decoder } from "@worker/utils/string";

interface EmailProcessingContext {
  account: Account;
  provider: EmailProvider;
}

interface EmailDeliveryBatchOptions {
  deadlineMs: number;
  maxItems: number;
}

export interface EmailDeliveryFailureContext {
  claimState: EmailDeliveryState | null | "unavailable";
  hasMapping: boolean | "unavailable";
}

export interface EmailDeliveryScheduleContext {
  deadlineMs: number | null;
  remaining: number;
  tail: Promise<void>;
}

export interface EmailDeliveryRequest {
  accountId: number;
  emailMessageId: string;
}

const EMAIL_DELIVERY_BACKGROUND_BUDGET_MS = 20_000;
const EMAIL_DELIVERY_STALE_SENDING_MS = 2 * 60 * 1_000;
const MAX_EMAIL_DELIVERIES_PER_INVOCATION = 10;

export const createEmailDeliveryScheduleContext =
  (): EmailDeliveryScheduleContext => ({
    deadlineMs: null,
    remaining: MAX_EMAIL_DELIVERIES_PER_INVOCATION,
    tail: Promise.resolve(),
  });

export const reserveEmailDeliveryRequests = (
  requests: EmailDeliveryRequest[],
  context: EmailDeliveryScheduleContext,
): EmailDeliveryRequest[] => {
  const reserved = dedupeEmailDeliveryRequests(requests).slice(
    0,
    context.remaining,
  );
  context.remaining -= reserved.length;
  return reserved;
};

export const scheduleEmailDeliveries = (
  env: Env,
  requests: EmailDeliveryRequest[],
  waitUntil: WaitUntil,
  context = createEmailDeliveryScheduleContext(),
): number => {
  const scheduledRequests = reserveEmailDeliveryRequests(requests, context);
  if (scheduledRequests.length === 0) return 0;
  if (context.deadlineMs === null) {
    context.deadlineMs = Date.now() + EMAIL_DELIVERY_BACKGROUND_BUDGET_MS;
  }
  const deadlineMs = context.deadlineMs;
  const process = () =>
    processEmailDeliveries(env, scheduledRequests, waitUntil, deadlineMs);
  const delivery = context.tail.then(process, process);
  context.tail = delivery;
  waitUntil(delivery);
  return scheduledRequests.length;
};

export const processEmailDeliveries = async (
  env: Env,
  requests: EmailDeliveryRequest[],
  waitUntil: WaitUntil,
  deadlineMs = Number.POSITIVE_INFINITY,
): Promise<void> => {
  const contextCache = new Map<number, EmailProcessingContext | null>();
  await markStaleEmailDeliveriesUnknown(
    env.DB,
    new Date(Date.now() - EMAIL_DELIVERY_STALE_SENDING_MS),
  ).catch((error) =>
    reportErrorToObservability(
      env,
      "email.delivery_state_reconciliation_failed",
      error,
    ).catch(() => {}),
  );
  await runEmailDeliveryBatch(
    requests,
    async (request) => {
      try {
        await processEmailDelivery(env, request, waitUntil, contextCache);
      } catch (error) {
        const { claimState, hasMapping } = await getEmailDeliveryFailureContext(
          env.DB,
          request.accountId,
          request.emailMessageId,
        );
        await reportErrorToObservability(
          env,
          "email.direct_delivery_failed",
          error,
          {
            accountId: request.accountId,
            emailMessageId: request.emailMessageId,
            claimState,
            hasMapping,
          },
        ).catch(() => {});
      }
    },
    { deadlineMs, maxItems: MAX_EMAIL_DELIVERIES_PER_INVOCATION },
  );
};

export const runEmailDeliveryBatch = async (
  requests: EmailDeliveryRequest[],
  deliver: (request: EmailDeliveryRequest) => Promise<void>,
  options: EmailDeliveryBatchOptions = {
    deadlineMs: Number.POSITIVE_INFINITY,
    maxItems: Number.POSITIVE_INFINITY,
  },
): Promise<number> => {
  const unique = dedupeEmailDeliveryRequests(requests);
  let processed = 0;

  for (const request of unique) {
    if (processed >= options.maxItems || Date.now() >= options.deadlineMs) {
      break;
    }
    await deliver(request);
    processed += 1;
  }
  return processed;
};

export const clearMissingEmailDelivery = async (
  d1: D1Database,
  accountId: number,
  emailMessageId: string,
  error: unknown,
): Promise<boolean> => {
  if (!(error instanceof EmailMessageNotFoundError)) return false;
  await deleteEmailDelivery(d1, accountId, emailMessageId);
  return true;
};

export const getEmailDeliveryFailureContext = async (
  d1: D1Database,
  accountId: number,
  emailMessageId: string,
): Promise<EmailDeliveryFailureContext> => {
  const [claimState, hasMapping] = await Promise.all([
    getEmailDeliveryState(d1, accountId, emailMessageId).catch(
      () => "unavailable" as const,
    ),
    getMappingsByEmailIds(d1, accountId, [emailMessageId])
      .then((mappings) => mappings.length > 0)
      .catch(() => "unavailable" as const),
  ]);
  return { claimState, hasMapping };
};

const processEmailDelivery = async (
  env: Env,
  request: EmailDeliveryRequest,
  waitUntil: WaitUntil,
  contextCache: Map<number, EmailProcessingContext | null>,
): Promise<void> => {
  const context = await getEmailProcessingContext(env, request, contextCache);
  if (!context) {
    await deleteEmailDelivery(
      env.DB,
      request.accountId,
      request.emailMessageId,
    );
    return;
  }
  const { account, provider } = context;
  const isDelivered = async (): Promise<boolean> =>
    (
      await getMappingsByEmailIds(env.DB, request.accountId, [
        request.emailMessageId,
      ])
    ).length > 0;

  try {
    await coordinateEmailDelivery({
      isDelivered,
      ensurePending: () =>
        ensureEmailDeliveryPending(
          env.DB,
          request.accountId,
          request.emailMessageId,
        ),
      claim: () =>
        claimEmailDelivery(env.DB, request.accountId, request.emailMessageId),
      isRetryableError: (error) => error instanceof TelegramRateLimitError,
      markRetryable: () =>
        markEmailDeliveryRetryable(
          env.DB,
          request.accountId,
          request.emailMessageId,
        ),
      deliver: async (beforeSend) => {
        const { rawEmail, state } = await provider.fetchRawEmailWithState(
          request.emailMessageId,
        );
        if (isDeliveryFailure(rawEmail)) {
          await provider.markAsRead(request.emailMessageId).catch((error) =>
            reportErrorToObservability(
              env,
              "email.mark_delivery_failure_read_failed",
              error,
              {
                accountId: request.accountId,
                emailMessageId: request.emailMessageId,
              },
            ).catch(() => {}),
          );
          return "skipped";
        }
        return deliverEmailToTelegram(
          rawEmail,
          request.emailMessageId,
          account,
          env,
          waitUntil,
          state,
          { beforeSend },
        );
      },
      markUnknown: () =>
        markEmailDeliveryUnknown(
          env.DB,
          request.accountId,
          request.emailMessageId,
        ),
      clear: () =>
        deleteEmailDelivery(env.DB, request.accountId, request.emailMessageId),
    });
  } catch (error) {
    if (
      await clearMissingEmailDelivery(
        env.DB,
        request.accountId,
        request.emailMessageId,
        error,
      )
    ) {
      console.log("Email no longer exists in INBOX, dropping", {
        accountId: request.accountId,
        emailMessageId: request.emailMessageId,
      });
      return;
    }
    throw error;
  }
};

const getEmailProcessingContext = async (
  env: Env,
  request: EmailDeliveryRequest,
  contextCache: Map<number, EmailProcessingContext | null>,
): Promise<EmailProcessingContext | null> => {
  if (contextCache.has(request.accountId)) {
    return contextCache.get(request.accountId) ?? null;
  }

  const account = await getAccountById(env.DB, request.accountId);
  if (!account) {
    console.log(
      `Account ${request.accountId} not found, skipping email ${request.emailMessageId}`,
    );
    contextCache.set(request.accountId, null);
    return null;
  }
  if (account.disabled) {
    console.log(
      `Account ${request.accountId} is disabled, dropping email ${request.emailMessageId}`,
    );
    contextCache.set(request.accountId, null);
    return null;
  }

  const context = { account, provider: getEmailProvider(account, env) };
  contextCache.set(request.accountId, context);
  return context;
};

const dedupeEmailDeliveryRequests = (
  requests: EmailDeliveryRequest[],
): EmailDeliveryRequest[] => {
  const unique = new Map<string, EmailDeliveryRequest>();
  for (const request of requests) {
    unique.set(`${request.accountId}:${request.emailMessageId}`, request);
  }
  return [...unique.values()];
};

const isDeliveryFailure = (rawEmail: ArrayBuffer): boolean => {
  const raw = utf8Decoder.decode(rawEmail).replace(/\r\n/g, "\n");
  return (
    /^content-type:\s*message\/delivery-status\b/im.test(raw) ||
    (/^reporting-mta:\s*.+$/im.test(raw) && /^action:\s*failed\b/im.test(raw))
  );
};
