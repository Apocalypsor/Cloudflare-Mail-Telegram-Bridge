import { deleteAccount } from "@worker/db/accounts";
import { deleteFailedEmailsByAccountId } from "@worker/db/failed-emails";
import {
  deleteCachedAccessToken,
  deleteCachedOutlookFolderIds,
} from "@worker/db/kv";
import { deleteMappingsByAccountId } from "@worker/db/message-map";
import { getEmailProvider } from "@worker/providers";
import type { Account, Env } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";

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
