import { getOwnAccounts } from "@db/accounts";
import { getMappingsByEmailIds, type MessageMapping } from "@db/message-map";
import { t } from "@i18n";
import {
  type EmailListItem,
  type EmailProvider,
  getEmailProvider,
} from "@providers";
import { buildMailPreviewUrl } from "@services/mail-preview";
import {
  deleteJunkMappings,
  markAllAsRead,
  syncStarButtonsForMappings,
  trashAllJunkEmails,
} from "@services/message-actions";
import { buildTgMessageLink } from "@services/telegram";
import { escapeMdV2 } from "@utils/markdown-v2";
import { reportErrorToObservability } from "@utils/observability";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Account, Env } from "@/types";

const MAX_PER_ACCOUNT = 20;

/** 生成邮件 web 预览链接 */
async function buildPreviewLink(
  env: Env,
  emailId: string,
  accountId: number,
): Promise<string | undefined> {
  if (!env.WORKER_URL) return undefined;
  return buildMailPreviewUrl(
    env.WORKER_URL,
    env.ADMIN_SECRET,
    emailId,
    accountId,
  );
}

interface ListItem {
  /** 列表显示标题：优先 LLM 生成的 short_summary，回退到邮件 subject */
  title?: string;
  tgLink?: string;
  previewLink?: string;
}

interface ListResult {
  account: Account;
  items: ListItem[];
  total: number;
  error?: string;
  mappings?: MessageMapping[];
}

interface ListConfig {
  icon: string;
  label: string;
  emptyText: string;
  errorEvent: string;
}

/** 查询单个账号的邮件列表，同时生成 TG 深链接和 web 预览链接 */
async function queryAccount(
  env: Env,
  account: Account,
  fetcher: (provider: EmailProvider) => Promise<EmailListItem[]>,
  errorEvent: string,
  afterMappings?: (
    mappings: MessageMapping[],
    account: Account,
  ) => Promise<void>,
  hideTgLinks = false,
): Promise<ListResult> {
  try {
    const provider = getEmailProvider(account, env);
    const msgs = await fetcher(provider);
    if (msgs.length === 0) return { account, items: [], total: 0 };

    // 列表始终需要 mapping：tgLink 需要它，short_summary 也存在 mapping 上
    const mappings = await getMappingsByEmailIds(
      env.DB,
      account.id,
      msgs.map((m) => m.id),
    );
    const mappingMap = new Map(mappings.map((m) => [m.email_message_id, m]));
    const allMappings = afterMappings ? mappings : undefined;

    const items = await Promise.all(
      msgs.map(async (msg) => {
        const mapping = mappingMap.get(msg.id);
        return {
          // 有 LLM 生成的 short_summary 就用它，否则回退到邮件 subject
          title: mapping?.short_summary || msg.subject,
          tgLink:
            mapping && !hideTgLinks
              ? buildTgMessageLink(mapping.tg_chat_id, mapping.tg_message_id)
              : undefined,
          previewLink: await buildPreviewLink(env, msg.id, account.id),
        };
      }),
    );

    return { account, items, total: msgs.length, mappings: allMappings };
  } catch (err) {
    await reportErrorToObservability(env, errorEvent, err, {
      accountId: account.id,
    });
    return {
      account,
      items: [],
      total: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 构建邮件列表结果文本 */
async function buildListText(
  env: Env,
  userId: string,
  fetcher: (provider: EmailProvider) => Promise<EmailListItem[]>,
  config: ListConfig,
  afterMappings?: (
    mappings: MessageMapping[],
    account: Account,
  ) => Promise<void>,
  hideTgLinks = false,
): Promise<{
  text: string;
  hasItems: boolean;
  pendingTasks?: (() => Promise<void>)[];
}> {
  const accounts = await getOwnAccounts(env.DB, userId);
  if (accounts.length === 0)
    return { text: t("common:label.noAccounts"), hasItems: false };

  const results = await Promise.all(
    accounts.map((acc) =>
      queryAccount(
        env,
        acc,
        fetcher,
        config.errorEvent,
        afterMappings,
        hideTgLinks,
      ),
    ),
  );

  const lines: string[] = [];
  let total = 0;

  for (const r of results) {
    const accountLabel = escapeMdV2(
      r.account.email || `Account #${r.account.id}`,
    );
    if (r.error) {
      lines.push(
        `❌ ${accountLabel}: ${escapeMdV2(t("common:error.queryFailed"))}`,
      );
      continue;
    }
    if (r.total === 0) continue;

    total += r.total;
    // i18n 模板里已给邮箱加了 __...__，这里只要把动态值预先转义
    lines.push(
      `\n${t("mailList:accountLabel", {
        label: escapeMdV2(r.account.email || `Account #${r.account.id}`),
        count: r.total,
        type: escapeMdV2(config.label),
      })}`,
    );
    for (const [i, item] of r.items.entries()) {
      if (i > 0) lines.push(""); // 空行断开 blockquote，让每封邮件独立成块
      lines.push(
        `>${escapeMdV2(item.title || t("common:label.noSubjectParen"))}`,
      );
      const linkParts: string[] = [];
      if (item.tgLink)
        linkParts.push(`[${t("mailList:tgMessage")}](${item.tgLink})`);
      if (item.previewLink)
        linkParts.push(`[${t("mailList:preview")}](${item.previewLink})`);
      if (linkParts.length > 0) lines.push(`>${linkParts.join(" ")}`);
    }
  }

  if (total === 0) return { text: config.emptyText, hasItems: false };

  // 收集需要在回复消息后执行的后台任务
  const pendingTasks: (() => Promise<void>)[] = [];
  if (afterMappings) {
    for (const r of results) {
      if (r.mappings && r.mappings.length > 0) {
        const mappings = r.mappings;
        const account = r.account;
        pendingTasks.push(() => afterMappings(mappings, account));
      }
    }
  }

  return {
    text: `${t("mailList:total", { icon: config.icon, total, label: config.label })}\n${lines.join("\n")}`,
    hasItems: true,
    pendingTasks,
  };
}

/* ------------------------------------------------------------------ */
/*  通用注册：每种邮件列表只需一份定义                                   */
/* ------------------------------------------------------------------ */

interface ListDef {
  name: string;
  fetcher: (p: EmailProvider) => Promise<EmailListItem[]>;
  config: ListConfig;
  afterMappings?: (
    mappings: MessageMapping[],
    account: Account,
  ) => Promise<void>;
  /** 隐藏 TG 消息链接（如 junk 列表，TG 消息已被自动删除） */
  hideTgLinks?: boolean;
  actionKeyboard?: InlineKeyboard;
  action?: {
    callbackName: string;
    loadingText: string;
    handler: (
      env: Env,
      userId: string,
    ) => Promise<{ success: number; failed: number }>;
    resultText: (success: number, failed: number) => string;
  };
}

function registerList(bot: Bot, env: Env, def: ListDef) {
  const replyMarkupOpt = (hasItems: boolean) =>
    hasItems && def.actionKeyboard ? { reply_markup: def.actionKeyboard } : {};

  const queryList = (userId: string) =>
    buildListText(
      env,
      userId,
      def.fetcher,
      def.config,
      def.afterMappings,
      def.hideTgLinks,
    );

  const schedulePendingTasks = (tasks?: (() => Promise<void>)[]) => {
    if (!tasks || tasks.length === 0) return;
    const run = async () => {
      for (const task of tasks) {
        await task();
      }
    };
    if (env.waitUntil) {
      env.waitUntil(run().catch(() => {}));
    }
  };

  bot.command(def.name, async (ctx) => {
    const userId = String(ctx.from?.id);
    const msg = await ctx.reply(
      t("mailList:querying", { label: def.config.label }),
    );
    const { text, hasItems, pendingTasks } = await queryList(userId);
    await ctx.api.editMessageText(msg.chat.id, msg.message_id, text, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      ...replyMarkupOpt(hasItems),
    });
    schedulePendingTasks(pendingTasks);
  });

  bot.callbackQuery(def.name, async (ctx) => {
    const userId = String(ctx.from.id);
    await ctx.answerCallbackQuery({ text: t("mailList:queryingShort") });
    const { text, hasItems, pendingTasks } = await queryList(userId);
    await ctx.reply(text, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      ...replyMarkupOpt(hasItems),
    });
    schedulePendingTasks(pendingTasks);
  });

  if (def.action) {
    const { callbackName, loadingText, handler, resultText } = def.action;
    bot.callbackQuery(callbackName, async (ctx) => {
      const userId = String(ctx.from.id);
      await ctx.answerCallbackQuery({ text: loadingText });
      const { success, failed } = await handler(env, userId);
      await ctx.editMessageText(resultText(success, failed));
    });
  }
}

export function registerMailListHandlers(bot: Bot, env: Env) {
  registerList(bot, env, {
    name: "unread",
    fetcher: (p) => p.listUnread(MAX_PER_ACCOUNT),
    config: {
      icon: t("mailList:unread.icon"),
      label: t("mailList:unread.label"),
      emptyText: t("mailList:unread.empty"),
      errorEvent: "bot.unread_query_failed",
    },
    actionKeyboard: new InlineKeyboard().text(
      t("mailList:unread.markAllRead"),
      "mark_all_read",
    ),
    action: {
      callbackName: "mark_all_read",
      loadingText: t("mailList:unread.marking"),
      handler: markAllAsRead,
      resultText: (s, f) =>
        f > 0
          ? t("mailList:unread.markResultWithFailed", {
              success: s,
              failed: f,
            })
          : t("mailList:unread.markResult", { success: s }),
    },
  });

  registerList(bot, env, {
    name: "starred",
    fetcher: (p) => p.listStarred(MAX_PER_ACCOUNT),
    config: {
      icon: t("mailList:starred.icon"),
      label: t("mailList:starred.label"),
      emptyText: t("mailList:starred.empty"),
      errorEvent: "bot.starred_query_failed",
    },
    afterMappings: (mappings, account) =>
      syncStarButtonsForMappings(env, mappings, account),
  });

  registerList(bot, env, {
    name: "archived",
    fetcher: (p) => p.listArchived(MAX_PER_ACCOUNT),
    config: {
      icon: t("mailList:archived.icon"),
      label: t("mailList:archived.label"),
      emptyText: t("mailList:archived.empty"),
      errorEvent: "bot.archived_query_failed",
    },
    hideTgLinks: true,
  });

  registerList(bot, env, {
    name: "junk",
    fetcher: (p) => p.listJunk(MAX_PER_ACCOUNT),
    config: {
      icon: t("mailList:junk.icon"),
      label: t("mailList:junk.label"),
      emptyText: t("mailList:junk.empty"),
      errorEvent: "bot.junk_query_failed",
    },
    afterMappings: (mappings, account) =>
      deleteJunkMappings(env, mappings, account),
    hideTgLinks: true,
    actionKeyboard: new InlineKeyboard().text(
      t("mailList:junk.deleteAll"),
      "delete_all_junk",
    ),
    action: {
      callbackName: "delete_all_junk",
      loadingText: t("mailList:junk.deleting"),
      handler: trashAllJunkEmails,
      resultText: (s, f) =>
        f > 0
          ? t("mailList:junk.deleteResultWithFailed", {
              success: s,
              failed: f,
            })
          : t("mailList:junk.deleteResult", { success: s }),
    },
  });
}
