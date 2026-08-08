import { getAllAccounts } from "@worker/db/accounts";
import { getMappingsByEmailIds } from "@worker/db/message-map";
import { getEmailProvider } from "@worker/providers";
import {
  type Account,
  AccountType,
  type Env,
  type WaitUntil,
} from "@worker/types";
import {
  createEmailDeliveryScheduleContext,
  scheduleEmailDeliveries,
} from "@worker/utils/mail-delivery/dispatch";
import { reportErrorToObservability } from "@worker/utils/observability";

export interface MailSyncResult {
  scheduled: number;
  error?: string;
}

export interface AccountMailSyncResult extends MailSyncResult {
  account: Account;
}

const DEFAULT_MAX_SYNC_PER_ACCOUNT = 50;

export const syncAccountUnreadMail = async (
  env: Env,
  account: Account,
  waitUntil: WaitUntil,
  maxMessages = DEFAULT_MAX_SYNC_PER_ACCOUNT,
  scheduleContext = createEmailDeliveryScheduleContext(),
): Promise<MailSyncResult> => {
  try {
    const provider = getEmailProvider(account, env);
    const unread = await provider.listUnread(maxMessages);
    if (unread.length === 0) return { scheduled: 0 };

    const mappings = await getMappingsByEmailIds(
      env.DB,
      account.id,
      unread.map((m) => m.id),
    );
    const delivered = new Set(mappings.map((m) => m.email_message_id));
    const newMessages = unread.filter((m) => !delivered.has(m.id));
    if (newMessages.length === 0) return { scheduled: 0 };

    const scheduled = scheduleEmailDeliveries(
      env,
      newMessages.map((m) => ({
        accountId: account.id,
        emailMessageId: m.id,
      })),
      waitUntil,
      scheduleContext,
    );
    return { scheduled };
  } catch (err) {
    await reportErrorToObservability(env, "mail_sync.account_failed", err, {
      accountId: account.id,
    });
    return {
      scheduled: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

export const syncAccountsUnreadMail = async (
  env: Env,
  accounts: Account[],
  waitUntil: WaitUntil,
): Promise<AccountMailSyncResult[]> => {
  const scheduleContext = createEmailDeliveryScheduleContext();
  return Promise.all(
    accounts.map(async (account) => ({
      account,
      ...(await syncAccountUnreadMail(
        env,
        account,
        waitUntil,
        DEFAULT_MAX_SYNC_PER_ACCOUNT,
        scheduleContext,
      )),
    })),
  );
};

export const syncAllEnabledAccountsUnreadMail = async (
  env: Env,
  waitUntil: WaitUntil,
): Promise<AccountMailSyncResult[]> => {
  const accounts = (await getAllAccounts(env.DB)).filter(canPollAccount);
  const results: AccountMailSyncResult[] = [];
  const scheduleContext = createEmailDeliveryScheduleContext();

  // ponytail: sequential scan keeps cron from bursting IMAP/API connections; add bounded concurrency if account count makes this too slow.
  for (const account of accounts) {
    results.push({
      account,
      ...(await syncAccountUnreadMail(
        env,
        account,
        waitUntil,
        DEFAULT_MAX_SYNC_PER_ACCOUNT,
        scheduleContext,
      )),
    });
  }

  return results;
};

const canPollAccount = (account: Account): boolean => {
  if (account.disabled) return false;
  if (account.type === AccountType.Imap) return true;
  return !!account.refresh_token;
};
