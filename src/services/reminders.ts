import {
  listDueReminders,
  markReminderSent,
  type Reminder,
} from "@db/reminders";
import { t } from "@i18n";
import { buildMailPreviewUrl } from "@services/mail-preview";
import { sendTextMessage } from "@services/telegram";
import { escapeMdV2 } from "@utils/markdown-v2";
import { reportErrorToObservability } from "@utils/observability";
import type { Env } from "@/types";

/** 备注最大长度（Telegram 单条消息上限是 4096） */
export const REMINDER_TEXT_MAX = 1000;
/** 单用户最多 pending 提醒数 */
export const REMINDER_PER_USER_LIMIT = 100;

/** 永久性失败：bot 被屏蔽 / 踢出群 / 用户停用 → 标记 sent_at 放弃，避免每分钟重试。 */
function isPermanentSendError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /\b(403|400)\b/.test(msg) &&
    /(blocked|kicked|deactivated|chat not found|chat_id is empty|bot was blocked|bot was kicked)/i.test(
      msg,
    )
  );
}

/**
 * 扫描 D1 中所有到期的提醒，发送并标记已发送。
 * 邮件提醒 → 发到原邮件落到的 chat（reply_to_message_id），附查看邮件按钮；
 * 通用提醒（旧数据，无邮件上下文）→ 发到用户私聊。
 *
 * 永久性失败（bot 被踢、被屏蔽）也标记 sent_at，避免无限重试；瞬态错误留在
 * pending，下分钟重试。
 */
export async function dispatchDueReminders(env: Env): Promise<void> {
  const due = await listDueReminders(env.DB, new Date().toISOString());
  if (due.length === 0) return;

  await Promise.allSettled(
    due.map(async (r) => {
      try {
        if (r.account_id != null && r.email_message_id != null) {
          await sendEmailReminder(env, r);
        } else {
          await sendGenericReminder(env, r);
        }
        await markReminderSent(env.DB, r.id);
      } catch (err) {
        if (isPermanentSendError(err)) {
          await markReminderSent(env.DB, r.id);
        }
        await reportErrorToObservability(env, "reminders.send_failed", err, {
          reminderId: r.id,
          telegramUserId: r.telegram_user_id,
          mode: r.email_message_id ? "email" : "generic",
        });
      }
    }),
  );
}

async function sendEmailReminder(env: Env, r: Reminder): Promise<void> {
  // 目标 chat：优先用投递时的 mapping（保证落到原邮件所在 chat，可能是群）；
  // 没有 mapping 时回退到用户私聊
  const targetChat = r.tg_chat_id ?? r.telegram_user_id;

  const lines = [t("reminders:reminderHeader")];
  if (r.email_subject) {
    lines.push(`📧 ${escapeMdV2(r.email_subject)}`);
  }
  if (r.text) {
    lines.push("", escapeMdV2(r.text));
  }
  const text = lines.join("\n");

  const replyMarkup =
    env.WORKER_URL && r.account_id != null && r.email_message_id != null
      ? {
          inline_keyboard: [
            [
              {
                text: t("reminders:viewMail"),
                url: await buildMailPreviewUrl(
                  env.WORKER_URL,
                  env.ADMIN_SECRET,
                  r.email_message_id,
                  r.account_id,
                ),
              },
            ],
          ],
        }
      : undefined;

  const extras: Record<string, unknown> = {
    link_preview_options: { is_disabled: true },
  };
  if (r.tg_message_id != null) {
    // reply_parameters: 替代旧的 reply_to_message_id；allow_sending_without_reply
    // 让原 TG 消息已被删除时也能正常发送（不报错）
    extras.reply_parameters = {
      message_id: r.tg_message_id,
      allow_sending_without_reply: true,
    };
  }

  await sendTextMessage(
    env.TELEGRAM_BOT_TOKEN,
    targetChat,
    text,
    replyMarkup,
    extras,
  );
}

async function sendGenericReminder(env: Env, r: Reminder): Promise<void> {
  const text = [
    t("reminders:reminderHeader"),
    "",
    escapeMdV2(r.text || "(无备注)"),
  ].join("\n");
  await sendTextMessage(env.TELEGRAM_BOT_TOKEN, r.telegram_user_id, text);
}
