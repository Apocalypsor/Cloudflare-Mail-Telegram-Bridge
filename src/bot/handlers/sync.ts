import { getOwnAccounts } from "@db/accounts";
import { getMappingsByEmailIds } from "@db/message-map";
import { getEmailProvider } from "@services/email/provider";
import { reportErrorToObservability } from "@utils/observability";
import type { Bot } from "grammy";
import type { Account, Env } from "@/types";

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
        body: { accountId: account.id, messageId: m.id },
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
  const accounts = await getOwnAccounts(env.DB, userId);
  if (accounts.length === 0) return "📭 暂无绑定的邮箱账号";

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
      lines.push(`❌ ${label}: 同步失败`);
    } else if (r.enqueued > 0) {
      totalEnqueued += r.enqueued;
      lines.push(`📧 ${label}: ${r.enqueued} 封新邮件`);
    } else {
      lines.push(`✅ ${label}: 无新邮件`);
    }
  }

  const header =
    totalEnqueued > 0
      ? `🔄 同步完成，${totalEnqueued} 封新邮件已入队处理`
      : "✅ 同步完成，没有新邮件";

  return `${header}\n\n${lines.join("\n")}`;
}

export function registerSyncHandler(bot: Bot, env: Env) {
  bot.command("sync", async (ctx) => {
    const userId = String(ctx.from?.id);
    const msg = await ctx.reply("🔄 正在同步邮件…");
    const result = await syncAllAccounts(env, userId);
    await ctx.api.editMessageText(msg.chat.id, msg.message_id, result);
  });

  bot.callbackQuery("sync", async (ctx) => {
    const userId = String(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "正在同步…" });
    const result = await syncAllAccounts(env, userId);
    await ctx.reply(result);
  });
}
