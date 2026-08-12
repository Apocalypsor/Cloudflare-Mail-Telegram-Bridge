import { RemindersService } from "@worker/api/modules/reminders/service";
import { TelegramClient } from "@worker/clients/telegram";
import { getAccountById } from "@worker/db/accounts";
import { deleteMessageMapping } from "@worker/db/message-map";
import {
  listDueReminders,
  markReminderSent,
  type Reminder,
} from "@worker/db/reminders";
import {
  TelegramApiError,
  TelegramApiErrorCode,
} from "@worker/errors/telegram";
import {
  ScheduledTask,
  type ScheduledTaskContext,
  type WaitUntil,
} from "@worker/handlers/scheduled/base";
import { t } from "@worker/i18n";
import { getEmailProvider } from "@worker/providers";
import type { Account, Env } from "@worker/types";
import {
  buildMiniAppMailUrl,
  generateMailTokenById,
} from "@worker/utils/mail/token";
import { deliverEmailToTelegram } from "@worker/utils/mail-delivery/deliver";
import { escapeMdV2 } from "@worker/utils/markdown-v2";
import {
  cleanupTgForEmail,
  refreshEmailKeyboardAfterReminderChange,
} from "@worker/utils/message-actions";
import { reportErrorToObservability } from "@worker/utils/observability";
import { sleep } from "@worker/utils/sleep";
import { getWorkerBaseUrl } from "@worker/utils/url";
import { DrizzleQueryError } from "drizzle-orm/errors";

const DUE_REMINDERS_QUERY_RETRY_DELAYS_MS = [100, 300] as const;

export class DueRemindersTask extends ScheduledTask {
  constructor() {
    super("scheduled.reminders_failed");
  }

  protected async run({
    env,
    date,
    waitUntil,
  }: ScheduledTaskContext): Promise<void> {
    const due = await this.listDueRemindersForCron(env, date);
    if (!due) return;
    if (due.length === 0) return;

    await Promise.allSettled(
      due.map(async (r) => {
        try {
          if (r.account_id != null && r.email_message_id != null) {
            waitUntil(
              RemindersService.pushThingsTaskForDueEmailReminder(env, r).catch(
                () => {},
              ),
            );
            await this.sendEmailReminder(env, r, waitUntil);
          } else {
            await this.sendGenericReminder(env, r);
          }
          await this.markSentAndRefresh(env, r);
        } catch (err) {
          if (
            err instanceof TelegramApiError &&
            err.code === TelegramApiErrorCode.ChatUnavailable
          ) {
            await this.markSentAndRefresh(env, r);
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

  private async listDueRemindersForCron(
    env: Env,
    date: Date,
  ): Promise<Reminder[] | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await listDueReminders(env.DB, date);
      } catch (err) {
        if (!(err instanceof DrizzleQueryError)) throw err;

        const delayMs = DUE_REMINDERS_QUERY_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) {
          console.warn("scheduled.reminders_due_query_skipped", {
            attempts: attempt + 1,
            scheduledAt: date.toISOString(),
            message: err.message,
          });
          return null;
        }

        await sleep(delayMs);
      }
    }
  }

  private formatRemindAt(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
  }

  private async markSentAndRefresh(env: Env, r: Reminder): Promise<void> {
    await markReminderSent(env.DB, r.id);
    if (r.account_id == null || r.email_message_id == null) return;
    const account = await getAccountById(env.DB, r.account_id);
    if (!account) return;
    await refreshEmailKeyboardAfterReminderChange(
      env,
      account,
      r.email_message_id,
    ).catch((err) =>
      reportErrorToObservability(
        env,
        "reminders.refresh_keyboard_failed",
        err,
        {
          reminderId: r.id,
        },
      ),
    );
  }

  private async sendEmailReminder(
    env: Env,
    r: Reminder,
    waitUntil: WaitUntil,
  ): Promise<void> {
    const accountId = r.account_id as number;
    const emailMessageId = r.email_message_id as string;

    const lines = [
      t("reminders:reminderHeader"),
      `🕒 ${escapeMdV2(this.formatRemindAt(r.remind_at))}`,
    ];
    if (r.email_subject) {
      lines.push(`📧 ${escapeMdV2(r.email_subject)}`);
    }
    if (r.text) {
      lines.push("", escapeMdV2(r.text));
    }
    const text = lines.join("\n");

    const token = await generateMailTokenById(
      env.ADMIN_SECRET,
      emailMessageId,
      accountId,
    );
    const url = buildMiniAppMailUrl(
      getWorkerBaseUrl(env),
      emailMessageId,
      accountId,
      token,
    );
    const replyMarkup = {
      inline_keyboard: [[{ text: t("reminders:viewMail"), web_app: { url } }]],
    };

    await new TelegramClient(env).sendTextMessage(
      r.telegram_user_id,
      text,
      replyMarkup,
      {
        link_preview_options: { is_disabled: true },
      },
    );

    waitUntil(this.applyReminderSideEffects(env, r, waitUntil));
  }

  private async applyReminderSideEffects(
    env: Env,
    r: Reminder,
    waitUntil: WaitUntil,
  ): Promise<void> {
    const accountId = r.account_id as number;
    const emailMessageId = r.email_message_id as string;

    const account = await getAccountById(env.DB, accountId);
    if (!account) return;
    const provider = getEmailProvider(account, env);

    let location: string;
    try {
      const state = await provider.resolveMessageState(emailMessageId);
      location = state.location;
    } catch (err) {
      await reportErrorToObservability(
        env,
        "reminders.resolve_state_failed",
        err,
        { reminderId: r.id, accountId, emailMessageId },
      );
      return;
    }
    if (location !== "inbox") {
      console.log(
        `Reminder ${r.id}: email is in ${location}, cleaning Telegram message`,
      );
      await cleanupTgForEmail(env, accountId, emailMessageId);
      return;
    }

    const starP = provider.addStar(emailMessageId).catch((err) =>
      reportErrorToObservability(env, "reminders.star_failed", err, {
        reminderId: r.id,
        accountId,
        emailMessageId,
      }),
    );

    const pinP = (async () => {
      if (r.tg_chat_id == null || r.tg_message_id == null) return;
      let status: Awaited<ReturnType<TelegramClient["pinChatMessage"]>>;
      try {
        status = await new TelegramClient(env).pinChatMessage(
          r.tg_chat_id,
          r.tg_message_id,
        );
      } catch (err) {
        await reportErrorToObservability(env, "reminders.pin_failed", err, {
          reminderId: r.id,
          chatId: r.tg_chat_id,
          tgMessageId: r.tg_message_id,
        });
        return;
      }
      if (status !== "not_found") return;
      await this.redeliverEmail(env, account, emailMessageId, waitUntil).catch(
        (err) =>
          reportErrorToObservability(env, "reminders.redeliver_failed", err, {
            reminderId: r.id,
            accountId,
            emailMessageId,
          }),
      );
    })();

    await Promise.allSettled([starP, pinP]);

    await refreshEmailKeyboardAfterReminderChange(
      env,
      account,
      emailMessageId,
    ).catch((err) =>
      reportErrorToObservability(
        env,
        "reminders.refresh_keyboard_failed",
        err,
        {
          reminderId: r.id,
          accountId,
          emailMessageId,
        },
      ),
    );
  }

  private async redeliverEmail(
    env: Env,
    account: Account,
    emailMessageId: string,
    waitUntil: WaitUntil,
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

  private async sendGenericReminder(env: Env, r: Reminder): Promise<void> {
    const text = [
      t("reminders:reminderHeader"),
      `🕒 ${escapeMdV2(this.formatRemindAt(r.remind_at))}`,
      "",
      escapeMdV2(r.text || "(无备注)"),
    ].join("\n");
    await new TelegramClient(env).sendTextMessage(r.telegram_user_id, text);
  }
}
