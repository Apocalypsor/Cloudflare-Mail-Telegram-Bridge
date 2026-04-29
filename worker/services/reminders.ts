import { getAccountById } from "@db/accounts";
import { deleteMessageMapping } from "@db/message-map";
import {
  listDueReminders,
  markReminderSent,
  type Reminder,
} from "@db/reminders";
import { t } from "@i18n";
import { getEmailProvider } from "@providers";
import { deliverEmailToTelegram } from "@services/bridge";
import { refreshEmailKeyboardAfterReminderChange } from "@services/message-actions";
import { pinChatMessage, sendTextMessage } from "@services/telegram";
import { buildMiniAppMailUrl, generateMailTokenById } from "@utils/mail-token";
import { escapeMdV2 } from "@utils/markdown-v2";
import { reportErrorToObservability } from "@utils/observability";
import type { Account, Env } from "@/types";

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

/** 把存的 UTC ISO 格式化成 "YYYY-MM-DD HH:MM UTC" —— 服务端不知道用户时区，
 *  所以统一显示 UTC 并明确标注，用户自行换算。 */
function formatRemindAt(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** 标 sent_at 后给邮件 TG 键盘做一次刷新 —— 让 ⏰ 上的 count -1。
 *  通用提醒（无邮件上下文）跳过；refresh 失败仅观测上报，不抛出。 */
async function markSentAndRefresh(env: Env, r: Reminder): Promise<void> {
  await markReminderSent(env.DB, r.id);
  if (r.account_id == null || r.email_message_id == null) return;
  const account = await getAccountById(env.DB, r.account_id);
  if (!account) return;
  await refreshEmailKeyboardAfterReminderChange(
    env,
    account,
    r.email_message_id,
  ).catch((err) =>
    reportErrorToObservability(env, "reminders.refresh_keyboard_failed", err, {
      reminderId: r.id,
    }),
  );
}

/**
 * 扫描 D1 中所有到期的提醒，发送并标记已发送。
 * 全部走用户私聊（telegram_user_id），不再投递到原邮件所在 chat ——
 * 个人提醒不应在群里炸出来。查看邮件按钮用 Mini App URL（私聊 web_app 有效）。
 *
 * 永久性失败（bot 被屏蔽、用户停用）也标记 sent_at，避免无限重试；瞬态错误
 * 留在 pending，下分钟重试。
 *
 * `waitUntil` 来自 cron 的 `ctx.waitUntil` —— 邮件 reminder 触发时的副作用
 * （pin / star / 必要时重投递）走 background fire-and-forget，不阻塞 cron tick。
 */
export async function dispatchDueReminders(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  const due = await listDueReminders(env.DB, new Date().toISOString());
  if (due.length === 0) return;

  await Promise.allSettled(
    due.map(async (r) => {
      try {
        if (r.account_id != null && r.email_message_id != null) {
          await sendEmailReminder(env, r, waitUntil);
        } else {
          await sendGenericReminder(env, r);
        }
        await markSentAndRefresh(env, r);
      } catch (err) {
        if (isPermanentSendError(err)) {
          // 永久失败也算"发出了" —— count -1，键盘也刷新
          await markSentAndRefresh(env, r);
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

async function sendEmailReminder(
  env: Env,
  r: Reminder,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  // r.account_id 和 r.email_message_id 在调用前已确认非 null
  const accountId = r.account_id as number;
  const emailMessageId = r.email_message_id as string;

  const lines = [
    t("reminders:reminderHeader"),
    `🕒 ${escapeMdV2(formatRemindAt(r.remind_at))}`,
  ];
  if (r.email_subject) {
    lines.push(`📧 ${escapeMdV2(r.email_subject)}`);
  }
  if (r.text) {
    lines.push("", escapeMdV2(r.text));
  }
  const text = lines.join("\n");

  // 查看邮件按钮：Mini App URL（私聊 web_app inline 按钮有效）。
  // 没配 WORKER_URL 时不放按钮 —— 用户自己从邮件 TG 消息找原文。
  let replyMarkup: unknown;
  if (env.WORKER_URL) {
    const token = await generateMailTokenById(
      env.ADMIN_SECRET,
      emailMessageId,
      accountId,
    );
    const url = buildMiniAppMailUrl(
      env.WORKER_URL,
      emailMessageId,
      accountId,
      token,
    );
    replyMarkup = {
      inline_keyboard: [[{ text: t("reminders:viewMail"), web_app: { url } }]],
    };
  }

  await sendTextMessage(
    env.TELEGRAM_BOT_TOKEN,
    r.telegram_user_id,
    text,
    replyMarkup,
    { link_preview_options: { is_disabled: true } },
  );

  // 副作用：星标邮件 + 置顶原 TG 消息；TG 消息已被删 → 重投递。
  // 走 waitUntil 后台跑，不阻塞 cron tick。每步独立 catch + observability，
  // 一步失败不影响其它步。
  waitUntil(applyReminderSideEffects(env, r, waitUntil));
}

/** Reminder 触发时的副作用：星标邮件 + 置顶原 TG 消息。
 *  TG 消息已不在历史里（被删）→ 删旧 mapping，调 deliverEmailToTelegram 重投。 */
async function applyReminderSideEffects(
  env: Env,
  r: Reminder,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  const accountId = r.account_id as number;
  const emailMessageId = r.email_message_id as string;

  const account = await getAccountById(env.DB, accountId);
  if (!account) return;
  const provider = getEmailProvider(account, env);

  // 1) 星标 —— 不依赖 TG 状态，跟 pin 并行
  const starP = provider.addStar(emailMessageId).catch((err) =>
    reportErrorToObservability(env, "reminders.star_failed", err, {
      reminderId: r.id,
      accountId,
      emailMessageId,
    }),
  );

  // 2) 置顶 —— 拿到 status 决定下一步
  const pinP = (async () => {
    if (r.tg_chat_id == null || r.tg_message_id == null) return;
    let status: Awaited<ReturnType<typeof pinChatMessage>>;
    try {
      status = await pinChatMessage(
        env.TELEGRAM_BOT_TOKEN,
        r.tg_chat_id,
        r.tg_message_id,
      );
    } catch (err) {
      // 非 not-found / 非限流的真错（403 群权限不够等）—— 上观测，不抛
      await reportErrorToObservability(env, "reminders.pin_failed", err, {
        reminderId: r.id,
        chatId: r.tg_chat_id,
        tgMessageId: r.tg_message_id,
      });
      return;
    }
    if (status !== "not_found") return;
    // TG 消息被用户删了 → 重投递一份
    await redeliverEmail(env, account, emailMessageId, waitUntil).catch((err) =>
      reportErrorToObservability(env, "reminders.redeliver_failed", err, {
        reminderId: r.id,
        accountId,
        emailMessageId,
      }),
    );
  })();

  await Promise.allSettled([starP, pinP]);
}

/** 把邮件重新投递到 TG 聊天。先删旧 mapping 防止 `(chat_id, email_message_id,
 *  account_id)` 唯一索引挡住。`deliverEmailToTelegram` 内部会 reconcile 远端状态，
 *  邮件已经不在 inbox（被归档/删了）就跳过。 */
async function redeliverEmail(
  env: Env,
  account: Account,
  emailMessageId: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  const provider = getEmailProvider(account, env);
  const rawEmail = await provider.fetchRawEmail(emailMessageId);
  await deleteMessageMapping(env.DB, account.id, emailMessageId);
  await deliverEmailToTelegram(
    rawEmail,
    emailMessageId,
    account,
    env,
    waitUntil,
  );
}

async function sendGenericReminder(env: Env, r: Reminder): Promise<void> {
  const text = [
    t("reminders:reminderHeader"),
    `🕒 ${escapeMdV2(formatRemindAt(r.remind_at))}`,
    "",
    escapeMdV2(r.text || "(无备注)"),
  ].join("\n");
  await sendTextMessage(env.TELEGRAM_BOT_TOKEN, r.telegram_user_id, text);
}
