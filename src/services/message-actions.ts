import { buildEmailKeyboard } from "@bot/keyboards";
import { getAccountById, getOwnAccounts } from "@db/accounts";
import {
  deleteMappingByEmailId,
  getMessageMapping,
  type MessageMapping,
} from "@db/message-map";
import { accountCanArchive, getEmailProvider } from "@providers";
import type { MessageLocation, MessageState } from "@providers/types";
import {
  deleteMessage,
  pinChatMessage,
  setReplyMarkup,
  unpinChatMessage,
} from "@services/telegram";
import { reportErrorToObservability } from "@utils/observability";
import type { InlineKeyboard } from "grammy";
import type { Account, Env } from "@/types";

type ToggleStarResult =
  | { ok: true; keyboard: InlineKeyboard; emailMessageId: string }
  | { ok: false; reason: string };

/** 删除 TG 消息 + mapping（邮件不再归属 INBOX 时统一清理） */
async function removeFromTelegram(
  env: Env,
  mapping: MessageMapping,
): Promise<void> {
  await deleteMessage(
    env.TELEGRAM_BOT_TOKEN,
    mapping.tg_chat_id,
    mapping.tg_message_id,
  ).catch(() => {});
  await deleteMappingByEmailId(
    env.DB,
    mapping.email_message_id,
    mapping.account_id,
  ).catch(() => {});
}

/**
 * 把远端状态对账到 TG：查 provider 里这条邮件现在的位置
 *  - junk / archive / deleted →  删 TG 消息 + mapping
 *  - inbox                    →  同步 star keyboard + pin 状态
 *
 * 所有需要「远端变更同步回 TG」的入口（refresh、未来的扩展触点）都走这一个函数。
 * 各 provider 在 `resolveMessageState` 内部尽量合并成少量 API 调用。
 */
export async function reconcileMessageState(
  env: Env,
  account: Account,
  mapping: MessageMapping,
): Promise<
  | { status: "removed"; location: Exclude<MessageLocation, "inbox"> }
  | { status: "inbox"; starred: boolean }
> {
  const provider = getEmailProvider(account, env);
  let state: MessageState;
  try {
    state = await provider.resolveMessageState(
      mapping.email_message_id,
      mapping.rfc_message_id,
    );
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
  return { status: "inbox", starred: state.starred };
}

/**
 * 同步 TG 消息的置顶状态以匹配星标状态。best-effort —— 失败仅上报观测、不抛出，
 * 避免因缺少 `can_pin_messages` 权限等环境问题打断星标主流程。
 */
export async function syncStarPinState(
  env: Env,
  chatId: string,
  tgMessageId: number,
  starred: boolean,
): Promise<void> {
  try {
    if (starred) {
      await pinChatMessage(env.TELEGRAM_BOT_TOKEN, chatId, tgMessageId);
    } else {
      await unpinChatMessage(env.TELEGRAM_BOT_TOKEN, chatId, tgMessageId);
    }
  } catch (err) {
    await reportErrorToObservability(env, "tg.pin_sync_failed", err, {
      chatId,
      tgMessageId,
      starred,
    });
  }
}

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
  );
  return { ok: true, keyboard, emailMessageId: mapping.email_message_id };
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

/** 标记用户所有账号的未读邮件为已读 */
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
      const unread = await provider.listUnread(maxPerAccount);
      await Promise.all(
        unread.map(async (msg) => {
          try {
            await provider.markAsRead(msg.id);
            success++;
          } catch {
            failed++;
          }
        }),
      );
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

/** 删除垃圾邮件对应的 Telegram 消息和映射（junk 列表刷新时调用） */
export async function deleteJunkMappings(
  env: Env,
  mappings: MessageMapping[],
): Promise<void> {
  for (const m of mappings) {
    await deleteMessage(
      env.TELEGRAM_BOT_TOKEN,
      m.tg_chat_id,
      m.tg_message_id,
    ).catch(() => {});
    await deleteMappingByEmailId(
      env.DB,
      m.email_message_id,
      m.account_id,
    ).catch(() => {});
  }
}

/** 批量同步 Telegram 消息的星标按钮状态（starred 列表刷新时调用） */
export async function syncStarButtonsForMappings(
  env: Env,
  mappings: MessageMapping[],
  account: Account,
): Promise<void> {
  const canArchive = accountCanArchive(account);
  for (const m of mappings) {
    try {
      const keyboard = await buildEmailKeyboard(
        env,
        m.email_message_id,
        account.id,
        true,
        canArchive,
      );
      await setReplyMarkup(
        env.TELEGRAM_BOT_TOKEN,
        m.tg_chat_id,
        m.tg_message_id,
        keyboard,
      );
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("message is not modified")
      ) {
        // keyboard 已是最新，但 pin 状态仍可能漂移（用户刚在 web 端加星），继续同步
      } else {
        await reportErrorToObservability(
          env,
          "bot.sync_star_button_failed",
          err,
          {
            chatId: m.tg_chat_id,
            messageId: m.tg_message_id,
          },
        );
        continue;
      }
    }
    await syncStarPinState(env, m.tg_chat_id, m.tg_message_id, true);
  }
}
