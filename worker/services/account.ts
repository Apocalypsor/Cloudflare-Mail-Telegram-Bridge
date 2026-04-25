import { deleteAccount, getOwnAccounts } from "@db/accounts";
import { deleteFailedEmailsByAccountId } from "@db/failed-emails";
import { deleteCachedAccessToken, deleteCachedOutlookFolderIds } from "@db/kv";
import { deleteMappingsByAccountId } from "@db/message-map";
import { deleteUser } from "@db/users";
import { getEmailProvider } from "@providers";
import { reportErrorToObservability } from "@utils/observability";
import type { Account, Env } from "@/types";

/** 清理并删除单个邮箱账号（停止 watch/subscription + 删除关联数据 + 删除 DB 记录） */
export async function cleanupAndDeleteAccount(
  env: Env,
  account: Account,
): Promise<void> {
  const provider = getEmailProvider(account, env);
  // 删除前：OAuth providers 停 push；IMAP 是 no-op
  if (account.refresh_token) {
    await provider.stopPush().catch((err) =>
      reportErrorToObservability(env, "bot.stop_push_failed", err, {
        accountEmail: account.email,
      }),
    );
  }
  await deleteAccount(env.DB, account.id);
  // 删除后：IMAP 通知 bridge reconcile；OAuth 是 no-op
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

  // 清理关联数据及 KV 缓存
  await Promise.all([
    deleteMappingsByAccountId(env.DB, account.id),
    deleteFailedEmailsByAccountId(env.DB, account.id),
    deleteCachedAccessToken(env.EMAIL_KV, account.id),
    // Outlook folder ID 缓存（其他 provider 没写入也无副作用，统一删）
    deleteCachedOutlookFolderIds(env.EMAIL_KV, account.id),
  ]);
}

/** 删除用户及其绑定的所有邮箱账号 */
export async function deleteUserWithAccounts(
  env: Env,
  telegramId: string,
): Promise<void> {
  const accounts = await getOwnAccounts(env.DB, telegramId);
  for (const acc of accounts) {
    await cleanupAndDeleteAccount(env, acc);
  }
  await deleteUser(env.DB, telegramId);
}
