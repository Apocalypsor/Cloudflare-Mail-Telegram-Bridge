import { getAllAccounts } from "@db/accounts";
import { t } from "@i18n";
import { getEmailProvider } from "@services/email/factory";
import { sendTextMessage } from "@services/telegram";
import { escapeMdV2 } from "@utils/markdown-v2";
import { reportErrorToObservability } from "@utils/observability";
import { InlineKeyboard } from "grammy";
import {
  DIGEST_HOURS,
  MAX_DIGEST_LIST,
  MESSAGE_DATE_TIMEZONE,
} from "@/constants";
import type { Account, Env } from "@/types";

const DIGEST_KB = new InlineKeyboard()
  .text(t("digest:button.unreadList"), "unread")
  .text(t("digest:button.junkList"), "junk");

interface AccountDigest {
  account: Account;
  unread: number;
  junk: number;
  error?: string;
}

/** 检查当前是否为摘要发送时间 */
export function isDigestHour(scheduledTime: number): boolean {
  const localHour = getLocalHour(scheduledTime);
  return DIGEST_HOURS.includes(localHour);
}

function getLocalHour(timestamp: number): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: MESSAGE_DATE_TIMEZONE,
    }).format(new Date(timestamp)),
  );
}

function getGreeting(hour: number): string {
  return hour < 12
    ? t("digest:greeting.morning")
    : t("digest:greeting.evening");
}

/** 为所有用户发送邮件摘要通知（私聊发送给用户本人） */
export async function sendDigestNotifications(
  env: Env,
  scheduledTime: number,
): Promise<void> {
  const localHour = getLocalHour(scheduledTime);
  const accounts = await getAllAccounts(env.DB);
  if (accounts.length === 0) return;

  // 按 telegram_user_id 分组，跳过没有用户 ID 的账号
  const userGroups = new Map<string, Account[]>();
  for (const account of accounts) {
    if (!account.telegram_user_id) continue;
    const group = userGroups.get(account.telegram_user_id) ?? [];
    group.push(account);
    userGroups.set(account.telegram_user_id, group);
  }

  await Promise.allSettled(
    [...userGroups.entries()].map(([userId, userAccounts]) =>
      sendDigestToUser(env, userId, userAccounts, localHour).catch(
        (error: unknown) =>
          reportErrorToObservability(env, "digest.send_failed", error, {
            userId,
          }),
      ),
    ),
  );
}

async function sendDigestToUser(
  env: Env,
  userId: string,
  accounts: Account[],
  localHour: number,
): Promise<void> {
  // 并发查询每个账号的未读和垃圾数
  const digests = await Promise.all(
    accounts.map((account) => queryAccountDigest(env, account)),
  );

  const totalUnread = digests.reduce((sum, d) => sum + d.unread, 0);
  const totalJunk = digests.reduce((sum, d) => sum + d.junk, 0);
  const hasErrors = digests.some((d) => d.error);

  // 全部为 0 且无错误，跳过发送
  if (totalUnread === 0 && totalJunk === 0 && !hasErrors) return;

  const greeting = getGreeting(localHour);
  const lines: string[] = [t("digest:header", { greeting }), ""];

  for (const d of digests) {
    const label = escapeMdV2(d.account.email || `Account #${d.account.id}`);
    if (d.error) {
      lines.push(`❌ ${label}: ${escapeMdV2(t("common:error.queryFailed"))}`);
      continue;
    }
    if (d.unread === 0 && d.junk === 0) continue;
    lines.push(`📧 ${label}`);
    lines.push(t("digest:accountStats", { unread: d.unread, junk: d.junk }));
  }

  if (totalUnread > 0 || totalJunk > 0) {
    lines.push("");
    lines.push(t("digest:total", { unread: totalUnread, junk: totalJunk }));
  }

  const text = lines.join("\n");
  await sendTextMessage(env.TELEGRAM_BOT_TOKEN, userId, text, DIGEST_KB);
}

async function queryAccountDigest(
  env: Env,
  account: Account,
): Promise<AccountDigest> {
  try {
    const provider = getEmailProvider(account, env);
    const [unread, junk] = await Promise.all([
      provider.listUnread(MAX_DIGEST_LIST),
      provider.listJunk(MAX_DIGEST_LIST),
    ]);
    return { account, unread: unread.length, junk: junk.length };
  } catch (err) {
    await reportErrorToObservability(env, "digest.account_query_failed", err, {
      accountId: account.id,
    });
    return {
      account,
      unread: 0,
      junk: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
