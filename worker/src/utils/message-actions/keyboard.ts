import { buildEmailKeyboard } from "@worker/bot/keyboards";
import { setReplyMarkup } from "@worker/clients/telegram";
import {
  getMappingsByEmailIds,
  type MessageMapping,
} from "@worker/db/message-map";
import { accountCanArchive, getEmailProvider } from "@worker/providers";
import type { Account, Env } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";
import { syncStarPinState } from "./reconcile";

/** 用最新的 reminder count 重建邮件 keyboard 并 setReplyMarkup。
 *  Mini App 创建/删除提醒后调用 —— 让 ⏰ 按钮上的数字立即更新。
 *  没 mapping（邮件没在 TG）或 setReplyMarkup 报 "not modified" 都静默跳过。 */
export async function refreshEmailKeyboardAfterReminderChange(
  env: Env,
  account: Account,
  emailMessageId: string,
): Promise<void> {
  const mappings = await getMappingsByEmailIds(env.DB, account.id, [
    emailMessageId,
  ]);
  const m = mappings[0];
  if (!m) return;

  const provider = getEmailProvider(account, env);
  const starred = await provider.isStarred(emailMessageId).catch(() => false);
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
    await setReplyMarkup(
      env.TELEGRAM_BOT_TOKEN,
      m.tg_chat_id,
      m.tg_message_id,
      keyboard,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("message is not modified"))
      return;
    await reportErrorToObservability(
      env,
      "reminder.refresh_keyboard_failed",
      err,
      { accountId: account.id, emailMessageId },
    );
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
        m.tg_chat_id,
        m.tg_message_id,
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
