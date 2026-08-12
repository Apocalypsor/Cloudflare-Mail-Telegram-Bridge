import { buildEmailKeyboard } from "@worker/bot/keyboards";
import { TelegramClient } from "@worker/clients/telegram";
import { getAccountById, getOwnAccounts } from "@worker/db/accounts";
import {
  deleteMappingByEmailId,
  getMappingsByEmailIds,
  getMessageMapping,
  type MessageMapping,
} from "@worker/db/message-map";
import {
  TelegramApiError,
  TelegramApiErrorCode,
} from "@worker/errors/telegram";
import { accountCanArchive, getEmailProvider } from "@worker/providers";
import type { MessageLocation, MessageState } from "@worker/providers/types";
import type { Account, Env } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";
import type { InlineKeyboard } from "grammy";

type ToggleStarResult =
  | { ok: true; keyboard: InlineKeyboard; emailMessageId: string }
  | { ok: false; reason: string };

interface MailMutationOptions {
  folder?: "inbox" | "junk" | "archive";
  waitUntil?: (p: Promise<unknown>) => void;
}

/** 删除 TG 消息 + mapping（邮件不再归属 INBOX 时统一清理）。
 *  调用方拿到了 mapping 时直接用；只有 (account, emailMessageId) 时用下面的
 *  `cleanupTgForEmail` 包一层。 */
export const removeFromTelegram = async (
  env: Env,
  mapping: MessageMapping,
): Promise<void> => {
  let removed = false;
  try {
    const result = await new TelegramClient(env).deleteMessageIfPresent(
      mapping.tg_chat_id,
      mapping.tg_message_id,
    );
    removed = result === "deleted" || result === "not_found";
    if (result === "unavailable") {
      removed = await markTelegramMessageAsRemoved(env, mapping);
    }
  } catch (err) {
    await reportErrorToObservability(env, "tg.delete_failed", err, {
      accountId: mapping.account_id,
      emailMessageId: mapping.email_message_id,
      chatId: mapping.tg_chat_id,
      tgMessageId: mapping.tg_message_id,
    });
  }

  if (!removed) return;

  await deleteMappingByEmailId(
    env.DB,
    mapping.email_message_id,
    mapping.account_id,
  ).catch((err) =>
    reportErrorToObservability(env, "tg.delete_mapping_failed", err, {
      accountId: mapping.account_id,
      emailMessageId: mapping.email_message_id,
      chatId: mapping.tg_chat_id,
      tgMessageId: mapping.tg_message_id,
    }),
  );
};

/** 邮件被 markAsJunk / archive / trash 之后清理 TG 侧的残留：
 *  查 mapping → 删 TG 消息 + mapping。没 mapping（邮件没投递过）就 no-op。 */
export const cleanupTgForEmail = async (
  env: Env,
  accountId: number,
  emailMessageId: string,
): Promise<void> => {
  const mappings = await getMappingsByEmailIds(env.DB, accountId, [
    emailMessageId,
  ]);
  if (mappings.length === 0) return;
  await removeFromTelegram(env, mappings[0]);
};

/** 删除非 INBOX 邮件对应的 Telegram 消息和映射（junk/archive 列表刷新时调用） */
export const deleteOutOfInboxMappings = async (
  env: Env,
  mappings: MessageMapping[],
): Promise<void> => {
  for (const m of mappings) {
    await removeFromTelegram(env, m);
  }
};

/**
 * 同步 TG 消息的置顶状态以匹配星标状态。best-effort —— 失败仅上报观测、不抛出，
 * 避免因缺少 `can_pin_messages` 权限等环境问题打断星标主流程。
 */
export const syncStarPinState = async (
  env: Env,
  chatId: string,
  tgMessageId: number,
  starred: boolean,
): Promise<void> => {
  try {
    if (starred) {
      await new TelegramClient(env).pinChatMessage(chatId, tgMessageId);
    } else {
      await new TelegramClient(env).unpinChatMessage(chatId, tgMessageId);
    }
  } catch (err) {
    await reportErrorToObservability(env, "tg.pin_sync_failed", err, {
      chatId,
      tgMessageId,
      starred,
    });
  }
};

/**
 * 把远端状态对账到 TG：查 provider 里这条邮件现在的位置
 *  - junk / archive / deleted →  删 TG 消息 + mapping
 *  - inbox                    →  同步 star keyboard + pin 状态
 *
 * 所有需要「远端变更同步回 TG」的入口（refresh、未来的扩展触点）都走这一个函数。
 * 各 provider 在 `resolveMessageState` 内部尽量合并成少量 API 调用。
 */
export const reconcileMessageState = async (
  env: Env,
  account: Account,
  mapping: MessageMapping,
): Promise<
  | { status: "removed"; location: Exclude<MessageLocation, "inbox"> }
  | { status: "inbox"; starred: boolean }
> => {
  const provider = getEmailProvider(account, env);
  let state: MessageState;
  try {
    state = await provider.resolveMessageState(mapping.email_message_id);
  } catch (err) {
    // provider 自己没把「找不到」转成 deleted（或网络错误）—— 不删 TG 消息，让上层感知
    await reportErrorToObservability(
      env,
      "reconcile.resolve_state_failed",
      err,
      {
        accountId: account.id,
        messageId: mapping.email_message_id,
      },
    );
    throw err;
  }

  if (state.location !== "inbox") {
    await removeFromTelegram(env, mapping);
    return { status: "removed", location: state.location };
  }

  await syncStarPinState(
    env,
    mapping.tg_chat_id,
    mapping.tg_message_id,
    state.starred,
  );

  // 顺便用最新代码重建键盘 —— 这是 refresh 的语义之一：让消息和当前
  // 配置/版本同步（比如新加的 ⏰ 按钮、归档标签刚刚配好可以解锁 📥 等）。
  // setReplyMarkup 在键盘没变化时会返回 "message is not modified"，吞掉。
  try {
    const keyboard = await buildEmailKeyboard(
      env,
      mapping.email_message_id,
      account.id,
      state.starred,
      accountCanArchive(account),
      mapping.tg_chat_id,
      mapping.tg_message_id,
    );
    await new TelegramClient(env).setReplyMarkup(
      mapping.tg_chat_id,
      mapping.tg_message_id,
      keyboard,
    );
  } catch (err) {
    if (
      !(
        err instanceof TelegramApiError &&
        err.code === TelegramApiErrorCode.MessageNotModified
      )
    ) {
      await reportErrorToObservability(
        env,
        "reconcile.refresh_keyboard_failed",
        err,
        { accountId: account.id, messageId: mapping.email_message_id },
      );
    }
  }

  return { status: "inbox", starred: state.starred };
};

/** 用最新的 reminder count 重建邮件 keyboard 并 setReplyMarkup。
 *  Mini App 创建/删除提醒后调用 —— 让 ⏰ 按钮上的数字立即更新。
 *  没 mapping（邮件没在 TG）或 setReplyMarkup 报 "not modified" 都静默跳过。 */
export const refreshEmailKeyboardAfterReminderChange = async (
  env: Env,
  account: Account,
  emailMessageId: string,
): Promise<void> => {
  const mappings = await getMappingsByEmailIds(env.DB, account.id, [
    emailMessageId,
  ]);
  const m = mappings[0];
  if (!m) return;

  const provider = getEmailProvider(account, env);
  const state = await provider
    .resolveMessageState(emailMessageId)
    .catch(async (err) => {
      await reportErrorToObservability(
        env,
        "reminder.resolve_state_failed",
        err,
        { accountId: account.id, emailMessageId },
      );
      return null;
    });
  if (state && state.location !== "inbox") {
    await removeFromTelegram(env, m);
    return;
  }
  const starred =
    state?.location === "inbox"
      ? state.starred
      : await provider.isStarred(emailMessageId).catch(() => false);
  const keyboard = await buildEmailKeyboard(
    env,
    emailMessageId,
    account.id,
    starred,
    accountCanArchive(account),
    m.tg_chat_id,
    m.tg_message_id,
  );
  try {
    await new TelegramClient(env).setReplyMarkup(
      m.tg_chat_id,
      m.tg_message_id,
      keyboard,
    );
  } catch (err) {
    if (
      err instanceof TelegramApiError &&
      err.code === TelegramApiErrorCode.MessageNotModified
    ) {
      return;
    }
    await reportErrorToObservability(
      env,
      "reminder.refresh_keyboard_failed",
      err,
      { accountId: account.id, emailMessageId },
    );
  }
};

/** 切换星标并返回新的 keyboard */
export const toggleStar = async (
  env: Env,
  chatId: string,
  messageId: number,
  starred: boolean,
): Promise<ToggleStarResult> => {
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
};

export const markEmailAsRead = async (
  env: Env,
  account: Account,
  emailMessageId: string,
  folder?: "inbox" | "junk" | "archive",
): Promise<void> => {
  try {
    const provider = getEmailProvider(account, env);
    await provider.markAsRead(emailMessageId, folder);
  } catch (err) {
    await reportErrorToObservability(env, "mark_read_failed", err, {
      accountId: account.id,
      emailMessageId,
    });
  }
};

export const markEmailAsJunkAndCleanup = async (
  env: Env,
  account: Account,
  emailMessageId: string,
  options?: MailMutationOptions,
): Promise<void> => {
  await scheduleOrAwait(
    markEmailAsRead(env, account, emailMessageId, options?.folder),
    options?.waitUntil,
  );
  const provider = getEmailProvider(account, env);
  await provider.markAsJunk(emailMessageId);
  await cleanupTgForEmail(env, account.id, emailMessageId);
};

export const archiveEmailAndCleanup = async (
  env: Env,
  account: Account,
  emailMessageId: string,
  options?: MailMutationOptions,
): Promise<void> => {
  await scheduleOrAwait(
    markEmailAsRead(env, account, emailMessageId, options?.folder),
    options?.waitUntil,
  );
  const provider = getEmailProvider(account, env);
  await provider.archiveMessage(emailMessageId);
  await cleanupTgForEmail(env, account.id, emailMessageId);
};

export const trashEmailAndCleanup = async (
  env: Env,
  account: Account,
  emailMessageId: string,
): Promise<void> => {
  const provider = getEmailProvider(account, env);
  await provider.trashMessage(emailMessageId);
  await cleanupTgForEmail(env, account.id, emailMessageId);
};

/** 通过 Telegram 消息标记对应邮件为已读 */
export const markAsReadByMessage = async (
  env: Env,
  chatId: string,
  messageId: number,
): Promise<void> => {
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
};

/** 标记用户所有账号的未读邮件为已读。各 provider 各自走 bulk API（Gmail
 *  batchModify / Outlook $batch / IMAP 单条 STORE），不再 N 次单调 modify。 */
export const markAllAsRead = async (
  env: Env,
  userId: string,
  maxPerAccount: number = 20,
): Promise<{ success: number; failed: number }> => {
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
};

/** 清空用户所有账号的垃圾邮件（移到回收站） */
export const trashAllJunkEmails = async (
  env: Env,
  userId: string,
): Promise<{ success: number; failed: number }> => {
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
};

const scheduleOrAwait = async (
  promise: Promise<unknown>,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<void> => {
  if (waitUntil) {
    waitUntil(promise);
    return;
  }
  await promise;
};

const REMOVED_FROM_INBOX_TEXT = "邮件已移出收件箱，Telegram 消息已失效。";
const EMPTY_INLINE_KEYBOARD = { inline_keyboard: [] };

const markTelegramMessageAsRemoved = async (
  env: Env,
  mapping: MessageMapping,
): Promise<boolean> => {
  try {
    await new TelegramClient(env).editRichMessage(
      mapping.tg_chat_id,
      mapping.tg_message_id,
      `<p>${REMOVED_FROM_INBOX_TEXT}</p>`,
      EMPTY_INLINE_KEYBOARD,
    );
    return true;
  } catch (err) {
    if (
      err instanceof TelegramApiError &&
      err.code === TelegramApiErrorCode.MessageNotModified
    ) {
      return true;
    }
    await reportRemovedFallbackFailure(env, mapping, err);
    return false;
  }
};

const reportRemovedFallbackFailure = async (
  env: Env,
  mapping: MessageMapping,
  err: unknown,
): Promise<void> => {
  await reportErrorToObservability(env, "tg.mark_removed_failed", err, {
    accountId: mapping.account_id,
    emailMessageId: mapping.email_message_id,
    chatId: mapping.tg_chat_id,
    tgMessageId: mapping.tg_message_id,
  });
};
