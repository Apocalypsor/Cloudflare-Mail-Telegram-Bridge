import { ROUTE_MINI_APP_LIST } from "@handlers/hono/routes";
import { t } from "@i18n";
import {
  getMailList,
  getPreviewFolder,
  type MailListResult,
  type MailListType,
} from "@services/mail-list";
import { buildMailPreviewUrl } from "@services/mail-preview";
import { markAllAsRead, trashAllJunkEmails } from "@services/message-actions";
import { buildTgMessageLink } from "@services/telegram";
import { escapeMdV2 } from "@utils/markdown-v2";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Env } from "@/types";

interface DisplayConfig {
  icon: string;
  label: string;
  emptyText: string;
}

const DISPLAY: Record<MailListType, DisplayConfig> = {
  unread: {
    icon: t("mailList:unread.icon"),
    label: t("mailList:unread.label"),
    emptyText: t("mailList:unread.empty"),
  },
  starred: {
    icon: t("mailList:starred.icon"),
    label: t("mailList:starred.label"),
    emptyText: t("mailList:starred.empty"),
  },
  junk: {
    icon: t("mailList:junk.icon"),
    label: t("mailList:junk.label"),
    emptyText: t("mailList:junk.empty"),
  },
  archived: {
    icon: t("mailList:archived.icon"),
    label: t("mailList:archived.label"),
    emptyText: t("mailList:archived.empty"),
  },
};

/** 把 service 返回的结构格式化成 MarkdownV2 文本 + 同时为每条邮件生成 web preview link */
async function formatList(
  env: Env,
  result: MailListResult,
): Promise<{ text: string; hasItems: boolean }> {
  const display = DISPLAY[result.type];
  const previewFolder = getPreviewFolder(result.type);

  const lines: string[] = [];
  for (const r of result.results) {
    const accountLabel = escapeMdV2(
      r.accountEmail || `Account #${r.accountId}`,
    );
    if (r.error) {
      lines.push(
        `❌ ${accountLabel}: ${escapeMdV2(t("common:error.queryFailed"))}`,
      );
      continue;
    }
    if (r.total === 0) continue;

    lines.push(
      `\n${t("mailList:accountLabel", {
        label: accountLabel,
        count: r.total,
        type: escapeMdV2(display.label),
      })}`,
    );
    for (const [i, item] of r.items.entries()) {
      if (i > 0) lines.push("");
      lines.push(
        `>${escapeMdV2(item.title || t("common:label.noSubjectParen"))}`,
      );
      const linkParts: string[] = [];
      if (item.tgChatId && item.tgMessageId)
        linkParts.push(
          `[${t("mailList:tgMessage")}](${buildTgMessageLink(item.tgChatId, item.tgMessageId)})`,
        );
      if (env.WORKER_URL) {
        const url = await buildMailPreviewUrl(
          env.WORKER_URL,
          env.ADMIN_SECRET,
          item.id,
          r.accountId,
          previewFolder,
        );
        linkParts.push(`[${t("mailList:preview")}](${url})`);
      }
      if (linkParts.length > 0) lines.push(`>${linkParts.join(" ")}`);
    }
  }

  if (result.total === 0) return { text: display.emptyText, hasItems: false };
  return {
    text: `${t("mailList:total", {
      icon: display.icon,
      total: result.total,
      label: display.label,
    })}\n${lines.join("\n")}`,
    hasItems: true,
  };
}

interface RegisterDef {
  type: MailListType;
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

function register(bot: Bot, env: Env, def: RegisterDef) {
  const replyMarkupOpt = (hasItems: boolean) =>
    hasItems && def.actionKeyboard ? { reply_markup: def.actionKeyboard } : {};

  const queryAndFormat = async (userId: string) => {
    const result = await getMailList(env, userId, def.type);
    const { text, hasItems } = await formatList(env, result);
    return { text, hasItems, pendingSideEffects: result.pendingSideEffects };
  };

  const schedule = (tasks: (() => Promise<void>)[]) => {
    if (tasks.length === 0 || !env.waitUntil) return;
    env.waitUntil(
      (async () => {
        for (const task of tasks) {
          try {
            await task();
          } catch {
            // 副作用失败不影响列表展示
          }
        }
      })(),
    );
  };

  bot.command(def.type, async (ctx) => {
    const display = DISPLAY[def.type];
    // 配了 WORKER_URL 就回一个 web_app 按钮打开 Mini App（私聊有效）。
    // 没配则回退到老的文本回复路径。
    if (env.WORKER_URL) {
      const url = `${env.WORKER_URL.replace(/\/$/, "")}${ROUTE_MINI_APP_LIST.replace(":type", def.type)}`;
      return ctx.reply(
        t("mailList:intro", { icon: display.icon, label: display.label }),
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: t("mailList:openInMiniApp", { label: display.label }),
                  web_app: { url },
                },
              ],
            ],
          },
        },
      );
    }
    const userId = String(ctx.from?.id);
    const msg = await ctx.reply(
      t("mailList:querying", { label: display.label }),
    );
    const { text, hasItems, pendingSideEffects } = await queryAndFormat(userId);
    await ctx.api.editMessageText(msg.chat.id, msg.message_id, text, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      ...replyMarkupOpt(hasItems),
    });
    schedule(pendingSideEffects);
  });

  bot.callbackQuery(def.type, async (ctx) => {
    const userId = String(ctx.from.id);
    await ctx.answerCallbackQuery({ text: t("mailList:queryingShort") });
    const { text, hasItems, pendingSideEffects } = await queryAndFormat(userId);
    await ctx.reply(text, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      ...replyMarkupOpt(hasItems),
    });
    schedule(pendingSideEffects);
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
  register(bot, env, {
    type: "unread",
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

  register(bot, env, { type: "starred" });

  register(bot, env, { type: "archived" });

  register(bot, env, {
    type: "junk",
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
