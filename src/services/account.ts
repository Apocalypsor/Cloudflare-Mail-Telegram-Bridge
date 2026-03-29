import { deleteAccount, getOwnAccounts } from "@db/accounts";
import { deleteFailedEmailsByAccountId } from "@db/failed-emails";
import { deleteCachedAccessToken } from "@db/kv";
import { deleteMappingsByAccountId } from "@db/message-map";
import { deleteUser } from "@db/users";
import { stopWatch } from "@services/email/gmail";
import { syncAccounts } from "@services/email/imap";
import { stopSubscription } from "@services/email/outlook";
import { reportErrorToObservability } from "@utils/observability";
import { type Account, AccountType, type Env } from "@/types";

/** 清理并删除单个邮箱账号（停止 watch/subscription + 删除关联数据 + 删除 DB 记录） */
export async function cleanupAndDeleteAccount(
  env: Env,
  account: Account,
): Promise<void> {
  // 停止邮件推送
  if (account.type === AccountType.Imap) {
    // IMAP 先删账号再同步，让中间件感知变更
    await deleteAccount(env.DB, account.id);
    if (env.IMAP_BRIDGE_URL && env.IMAP_BRIDGE_SECRET) {
      await syncAccounts(env).catch((err) => {
        reportErrorToObservability(env, "imap.sync_after_delete_failed", err, {
          accountId: account.id,
        });
      });
    }
  } else if (account.type === AccountType.Outlook) {
    if (account.refresh_token) {
      try {
        await stopSubscription(env, account);
      } catch (err) {
        await reportErrorToObservability(
          env,
          "bot.stop_subscription_failed",
          err,
          { accountEmail: account.email },
        );
      }
    }
    await deleteAccount(env.DB, account.id);
  } else {
    if (account.refresh_token) {
      try {
        await stopWatch(env, account);
      } catch (err) {
        await reportErrorToObservability(env, "bot.stop_watch_failed", err, {
          accountEmail: account.email,
        });
      }
    }
    await deleteAccount(env.DB, account.id);
  }

  // 清理关联数据及 KV 缓存
  await Promise.all([
    deleteMappingsByAccountId(env.DB, account.id),
    deleteFailedEmailsByAccountId(env.DB, account.id),
    deleteCachedAccessToken(env.EMAIL_KV, account.id),
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
