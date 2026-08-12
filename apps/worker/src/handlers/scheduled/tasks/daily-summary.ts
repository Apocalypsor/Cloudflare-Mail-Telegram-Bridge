import { ROUTE_MINI_APP_LIST } from "@page/paths";
import { TelegramClient } from "@worker/clients/telegram";
import { getOwnAccounts } from "@worker/db/accounts";
import {
  hasDailyMailSummaryProcessed,
  putDailyMailSummaryProcessed,
} from "@worker/db/kv";
import { getApprovedUsers } from "@worker/db/users";
import {
  ScheduledTask,
  type ScheduledTaskContext,
} from "@worker/handlers/scheduled/base";
import { t } from "@worker/i18n";
import { getEmailProvider } from "@worker/providers";
import type { EmailCount } from "@worker/providers/types";
import { type Account, AccountType, type Env } from "@worker/types";
import { escapeMdV2 } from "@worker/utils/markdown-v2";
import { reportErrorToObservability } from "@worker/utils/observability";
import { resolveUserTimeZone } from "@worker/utils/time-zone";
import { getWorkerBaseUrl } from "@worker/utils/url";
import { InlineKeyboard } from "grammy";

interface LocalDateTime {
  date: string;
  hour: number;
  minute: number;
}

interface MailCounts {
  unread: EmailCount;
  junk: EmailCount;
}

export class DailyMailSummaryTask extends ScheduledTask {
  private static readonly LOCAL_HOUR = 19;
  private static readonly MAX_COUNT = 1000;

  private readonly dateFormatterByTimeZone = new Map<
    string,
    Intl.DateTimeFormat
  >();

  constructor() {
    super("scheduled.daily_summaries_failed");
  }

  protected shouldRun(ctx: ScheduledTaskContext): boolean {
    return this.isQuarterHour(ctx);
  }

  protected async run({ env, date }: ScheduledTaskContext): Promise<void> {
    const users = await getApprovedUsers(env.DB);
    if (users.length === 0) return;

    await Promise.allSettled(
      users.map(async (user) => {
        const timeZone = resolveUserTimeZone(user.user_timezone);
        const local = this.getLocalDateTime(date, timeZone);
        if (
          local.hour !== DailyMailSummaryTask.LOCAL_HOUR ||
          local.minute !== 0
        ) {
          return;
        }

        try {
          await this.dispatchUserDailySummary(
            env,
            user.telegram_id,
            local.date,
          );
        } catch (err) {
          await reportErrorToObservability(
            env,
            "scheduled.daily_summary_failed",
            err,
            {
              telegramUserId: user.telegram_id,
              localDate: local.date,
              timeZone,
            },
          );
        }
      }),
    );
  }

  private getDateFormatter(timeZone: string): Intl.DateTimeFormat {
    const cached = this.dateFormatterByTimeZone.get(timeZone);
    if (cached) return cached;
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    this.dateFormatterByTimeZone.set(timeZone, formatter);
    return formatter;
  }

  private getPart(
    parts: Intl.DateTimeFormatPart[],
    type: Intl.DateTimeFormatPartTypes,
  ): string {
    return parts.find((part) => part.type === type)?.value ?? "";
  }

  private getLocalDateTime(date: Date, timeZone: string): LocalDateTime {
    const parts = this.getDateFormatter(timeZone).formatToParts(date);
    const year = this.getPart(parts, "year");
    const month = this.getPart(parts, "month");
    const day = this.getPart(parts, "day");
    const hour = Number(this.getPart(parts, "hour"));
    const minute = Number(this.getPart(parts, "minute"));
    return { date: `${year}-${month}-${day}`, hour, minute };
  }

  private isCountableAccount(account: Account): boolean {
    if (account.disabled === 1) return false;
    if (account.type === AccountType.Imap) return true;
    return !!account.refresh_token;
  }

  private mergeCounts(a: EmailCount, b: EmailCount): EmailCount {
    return {
      count: a.count + b.count,
      truncated: a.truncated || b.truncated,
    };
  }

  private formatCount(count: EmailCount): string {
    return count.truncated ? `${count.count}+` : String(count.count);
  }

  private buildDailySummaryText(counts: MailCounts): string {
    return [
      `*${escapeMdV2(t("dailySummary:title"))}*`,
      "",
      escapeMdV2(
        t("dailySummary:unread", {
          count: this.formatCount(counts.unread),
        }),
      ),
      escapeMdV2(
        t("dailySummary:junk", { count: this.formatCount(counts.junk) }),
      ),
    ].join("\n");
  }

  private buildDailySummaryKeyboard(
    env: Env,
    counts: MailCounts,
  ): InlineKeyboard | undefined {
    const kb = new InlineKeyboard();
    const base = getWorkerBaseUrl(env);
    const listUrl = (type: "unread" | "junk"): string =>
      `${base}${ROUTE_MINI_APP_LIST.replace(":type", type)}`;
    let hasButtons = false;

    if (counts.unread.count > 0) {
      kb.webApp(t("keyboards:menu.unread"), listUrl("unread"));
      hasButtons = true;
    }
    if (counts.junk.count > 0) {
      kb.webApp(t("keyboards:menu.junk"), listUrl("junk"));
      hasButtons = true;
    }

    return hasButtons ? kb : undefined;
  }

  private async countAccountMail(
    env: Env,
    account: Account,
  ): Promise<MailCounts> {
    const provider = getEmailProvider(account, env);
    const [unread, junk] = await Promise.all([
      provider.countUnread(DailyMailSummaryTask.MAX_COUNT),
      provider.countJunk(DailyMailSummaryTask.MAX_COUNT),
    ]);
    return { unread, junk };
  }

  private async countUserMail(
    env: Env,
    telegramUserId: string,
  ): Promise<MailCounts> {
    const accounts = (await getOwnAccounts(env.DB, telegramUserId)).filter(
      (account) => this.isCountableAccount(account),
    );
    let counts: MailCounts = {
      unread: { count: 0, truncated: false },
      junk: { count: 0, truncated: false },
    };

    for (const account of accounts) {
      const accountCounts = await this.countAccountMail(env, account).catch(
        (err) => {
          throw new Error(`Failed to count account ${account.id}`, {
            cause: err,
          });
        },
      );
      counts = {
        unread: this.mergeCounts(counts.unread, accountCounts.unread),
        junk: this.mergeCounts(counts.junk, accountCounts.junk),
      };
    }

    return counts;
  }

  private isEmptySummary(counts: MailCounts): boolean {
    return counts.unread.count === 0 && counts.junk.count === 0;
  }

  private async dispatchUserDailySummary(
    env: Env,
    telegramUserId: string,
    localDate: string,
  ): Promise<void> {
    if (
      await hasDailyMailSummaryProcessed(
        env.EMAIL_KV,
        telegramUserId,
        localDate,
      )
    ) {
      return;
    }

    const counts = await this.countUserMail(env, telegramUserId);
    if (this.isEmptySummary(counts)) {
      await putDailyMailSummaryProcessed(
        env.EMAIL_KV,
        telegramUserId,
        localDate,
      );
      return;
    }

    await new TelegramClient(env).sendTextMessage(
      telegramUserId,
      this.buildDailySummaryText(counts),
      this.buildDailySummaryKeyboard(env, counts),
    );
    await putDailyMailSummaryProcessed(env.EMAIL_KV, telegramUserId, localDate);
  }
}
