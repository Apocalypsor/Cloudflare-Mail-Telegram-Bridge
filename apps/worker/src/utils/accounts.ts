import { deleteAccount } from "@worker/db/accounts";
import { deleteEmailDeliveriesByAccountId } from "@worker/db/email-deliveries";
import { deleteFailedEmailsByAccountId } from "@worker/db/failed-emails";
import {
  deleteCachedAccessToken,
  deleteCachedOutlookFolderIds,
  deleteImapFolderPaths,
} from "@worker/db/kv";
import { deleteMappingsByAccountId } from "@worker/db/message-map";
import { getEmailProvider } from "@worker/providers";
import type { Account, Env } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";

/** Cleanly remove an email account and all local state derived from it. */
export const cleanupAndDeleteAccount = async (
  env: Env,
  account: Account,
): Promise<void> => {
  const provider = getEmailProvider(account, env);
  if (account.refresh_token) {
    await provider.stopPush().catch((err) =>
      reportErrorToObservability(env, "account.stop_push_failed", err, {
        accountEmail: account.email,
      }),
    );
  }

  await deleteAccount(env.DB, account.id);

  await provider.onPersistedChange().catch((err) =>
    reportErrorToObservability(
      env,
      "provider.on_persisted_change_failed",
      err,
      {
        accountId: account.id,
      },
    ),
  );

  await Promise.all([
    deleteEmailDeliveriesByAccountId(env.DB, account.id),
    deleteMappingsByAccountId(env.DB, account.id),
    deleteFailedEmailsByAccountId(env.DB, account.id),
    deleteCachedAccessToken(env.EMAIL_KV, account.id),
    deleteCachedOutlookFolderIds(env.EMAIL_KV, account.id),
    deleteImapFolderPaths(env.EMAIL_KV, account.id),
  ]);
};
