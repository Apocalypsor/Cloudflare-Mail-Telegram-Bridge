import { getOwnAccounts } from "@worker/db/accounts";
import { t } from "@worker/i18n";
import type { Env, WaitUntil } from "@worker/types";
import { syncAccountsUnreadMail } from "@worker/utils/mail-sync";
import type { Bot } from "grammy";

/** 同步用户所有账号的未读邮件 */
const syncAllAccounts = async (
  env: Env,
  userId: string,
  waitUntil: WaitUntil,
): Promise<string> => {
  const accounts = (await getOwnAccounts(env.DB, userId)).filter(
    (a) => !a.disabled,
  );
  if (accounts.length === 0) return t("common:label.noAccounts");

  const results = await syncAccountsUnreadMail(env, accounts, waitUntil);

  let totalScheduled = 0;
  const lines: string[] = [];
  for (const r of results) {
    const label = r.account.email || `Account #${r.account.id}`;
    if (r.error) {
      lines.push(t("sync:failed", { label }));
    } else if (r.scheduled > 0) {
      totalScheduled += r.scheduled;
      lines.push(t("sync:newEmails", { label, count: r.scheduled }));
    } else {
      lines.push(t("sync:noNewEmails", { label }));
    }
  }

  const header =
    totalScheduled > 0
      ? t("sync:completeWithNew", { count: totalScheduled })
      : t("sync:completeNoNew");

  return `${header}\n\n${lines.join("\n")}`;
};

export const registerSyncHandler = (
  bot: Bot,
  env: Env,
  waitUntil: WaitUntil,
) => {
  bot.callbackQuery("sync", async (ctx) => {
    const userId = String(ctx.from.id);
    await ctx.answerCallbackQuery({ text: t("sync:syncingShort") });
    const result = await syncAllAccounts(env, userId, waitUntil);
    await ctx.reply(result);
  });
};
