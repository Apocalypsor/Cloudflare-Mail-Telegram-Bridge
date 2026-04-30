import { buildEmailKeyboard } from "@worker/bot/keyboards";
import { getAccountById, getOwnAccounts } from "@worker/db/accounts";
import { getMessageMapping } from "@worker/db/message-map";
import { accountCanArchive, getEmailProvider } from "@worker/providers";
import type { Account, Env } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";
import type { InlineKeyboard } from "grammy";
import { syncStarPinState } from "./reconcile";

type ToggleStarResult =
  | { ok: true; keyboard: InlineKeyboard; emailMessageId: string }
  | { ok: false; reason: string };

/** 切换星标并返回新的 keyboard */
export async function toggleStar(
  env: Env,
  chatId: string,
  messageId: number,
  starred: boolean,
): Promise<ToggleStarResult> {
  const mapping = await getMessageMapping(env.DB, chatId, messageId);
  if (!mapping) return { ok: false, reason: "消息映射未找到" };

  const account = await getAccountById(env.DB, mapping.account_id);
  if (!account) return { ok: false, reason: "账号未找到" };

  const provider = getEmailProvider(account, env);
  if (starred) {
    await provider.addStar(mapping.email_message_id);
  } else {
    await provider.removeStar(mapping.email_message_id);
  }

  await syncStarPinState(
    env,
    mapping.tg_chat_id,
    mapping.tg_message_id,
    starred,
  );

  const keyboard = await buildEmailKeyboard(
    env,
    mapping.email_message_id,
    account.id,
    starred,
    accountCanArchive(account),
    mapping.tg_chat_id,
    mapping.tg_message_id,
  );
  return { ok: true, keyboard, emailMessageId: mapping.email_message_id };
}

/** Best-effort 标已读，失败上报但不抛——用于 preview 浏览 / star / archive /
 *  junk / trash 等"用户已经看过这封"的场景。`waitUntil` 友好。 */
export async function markEmailAsRead(
  env: Env,
  account: Account,
  emailMessageId: string,
): Promise<void> {
  try {
    const provider = getEmailProvider(account, env);
    await provider.markAsRead(emailMessageId);
  } catch (err) {
    await reportErrorToObservability(env, "mark_read_failed", err, {
      accountId: account.id,
      emailMessageId,
    });
  }
}

/** 通过 Telegram 消息标记对应邮件为已读 */
export async function markAsReadByMessage(
  env: Env,
  chatId: string,
  messageId: number,
): Promise<void> {
  const mapping = await getMessageMapping(env.DB, chatId, messageId);
  if (!mapping) {
    console.log(`No mapping found for chat=${chatId}, message=${messageId}`);
    return;
  }

  const account = await getAccountById(env.DB, mapping.account_id);
  if (!account) return;

  try {
    const provider = getEmailProvider(account, env);
    await provider.markAsRead(mapping.email_message_id);
    console.log(`Marked as read: message=${mapping.email_message_id}`);
  } catch (err) {
    await reportErrorToObservability(env, "bot.mark_read_failed", err, {
      messageId: mapping.email_message_id,
    });
  }
}

/** 标记用户所有账号的未读邮件为已读。各 provider 各自走 bulk API（Gmail
 *  batchModify / Outlook $batch / IMAP 单条 STORE），不再 N 次单调 modify。 */
export async function markAllAsRead(
  env: Env,
  userId: string,
  maxPerAccount: number = 20,
): Promise<{ success: number; failed: number }> {
  const accounts = await getOwnAccounts(env.DB, userId);
  let success = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      const provider = getEmailProvider(account, env);
      const result = await provider.markAllAsRead(maxPerAccount);
      success += result.success;
      failed += result.failed;
    } catch (err) {
      await reportErrorToObservability(env, "bot.mark_all_read_failed", err, {
        accountId: account.id,
      });
      failed++;
    }
  }

  return { success, failed };
}

/** 清空用户所有账号的垃圾邮件（移到回收站） */
export async function trashAllJunkEmails(
  env: Env,
  userId: string,
): Promise<{ success: number; failed: number }> {
  const accounts = await getOwnAccounts(env.DB, userId);
  let success = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      const provider = getEmailProvider(account, env);
      const count = await provider.trashAllJunk();
      success += count;
    } catch (err) {
      await reportErrorToObservability(env, "bot.delete_all_junk_failed", err, {
        accountId: account.id,
      });
      failed++;
    }
  }

  return { success, failed };
}
