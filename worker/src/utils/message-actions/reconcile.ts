import { buildEmailKeyboard } from "@worker/bot/keyboards";
import {
  pinChatMessage,
  setReplyMarkup,
  unpinChatMessage,
} from "@worker/clients/telegram";
import type { MessageMapping } from "@worker/db/message-map";
import { accountCanArchive, getEmailProvider } from "@worker/providers";
import type { MessageLocation, MessageState } from "@worker/providers/types";
import type { Account, Env } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";
import { removeFromTelegram } from "./cleanup";

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
    await setReplyMarkup(
      env.TELEGRAM_BOT_TOKEN,
      mapping.tg_chat_id,
      mapping.tg_message_id,
      keyboard,
    );
  } catch (err) {
    if (
      !(err instanceof Error && err.message.includes("message is not modified"))
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
