import { getOwnAccounts } from "@worker/db/accounts";
import { getMappingsByEmailIds } from "@worker/db/message-map";
import { t } from "@worker/i18n";
import { getEmailProvider } from "@worker/providers";
import { type Account, type Env, QueueMessageType } from "@worker/types";
import { reportErrorToObservability } from "@worker/utils/observability";
import type { Bot } from "grammy";

const MAX_SYNC_PER_ACCOUNT = 50;

/** 同步单个账号的未读邮件，返回入队数量 */
async function syncAccount(
  env: Env,
  account: Account,
): Promise<{ enqueued: number; error?: string }> {
  try {
    const provider = getEmailProvider(account, env);
    const unread = await provider.listUnread(MAX_SYNC_PER_ACCOUNT);
    if (unread.length === 0) return { enqueued: 0 };

    // 过滤已投递的邮件
    const mappings = await getMappingsByEmailIds(
      env.DB,
      account.id,
      unread.map((m) => m.id),
    );
    const delivered = new Set(mappings.map((m) => m.email_message_id));
    const newMessages = unread.filter((m) => !delivered.has(m.id));
    if (newMessages.length === 0) return { enqueued: 0 };

    await env.EMAIL_QUEUE.sendBatch(
      newMessages.map((m) => ({
        body: {
          type: QueueMessageType.Email,
          accountId: account.id,
          emailMessageId: m.id,
        },
      })),
    );
    return { enqueued: newMessages.length };
  } catch (err) {
    await reportErrorToObservability(env, "bot.sync_account_failed", err, {
      accountId: account.id,
    });
    return {
      enqueued: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 同步用户所有账号的未读邮件 */
async function syncAllAccounts(env: Env, userId: string): Promise<string> {
  const accounts = (await getOwnAccounts(env.DB, userId)).filter(
    (a) => !a.disabled,
  );
  if (accounts.length === 0) return t("common:label.noAccounts");

  const results = await Promise.all(
    accounts.map(async (acc) => {
      const result = await syncAccount(env, acc);
      return { account: acc, ...result };
    }),
  );

  let totalEnqueued = 0;
  const lines: string[] = [];
  for (const r of results) {
    const label = r.account.email || `Account #${r.account.id}`;
    if (r.error) {
      lines.push(t("sync:failed", { label }));
    } else if (r.enqueued > 0) {
      totalEnqueued += r.enqueued;
      lines.push(t("sync:newEmails", { label, count: r.enqueued }));
    } else {
      lines.push(t("sync:noNewEmails", { label }));
    }
  }

  const header =
    totalEnqueued > 0
      ? t("sync:completeWithNew", { count: totalEnqueued })
      : t("sync:completeNoNew");

  return `${header}\n\n${lines.join("\n")}`;
}

export function registerSyncHandler(bot: Bot, env: Env) {
  bot.command("sync", async (ctx) => {
    const userId = String(ctx.from?.id);
    const msg = await ctx.reply(t("sync:syncing"));
    const result = await syncAllAccounts(env, userId);
    await ctx.api.editMessageText(msg.chat.id, msg.message_id, result);
  });

  bot.callbackQuery("sync", async (ctx) => {
    const userId = String(ctx.from.id);
    await ctx.answerCallbackQuery({ text: t("sync:syncingShort") });
    const result = await syncAllAccounts(env, userId);
    await ctx.reply(result);
  });
}
