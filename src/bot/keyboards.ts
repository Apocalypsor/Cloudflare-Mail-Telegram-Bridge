import { getAccountById } from "@db/accounts";
import { getMessageMapping } from "@db/message-map";
import { t } from "@i18n";
import { getEmailProvider } from "@providers";
import { generateMailTokenById } from "@services/mail-preview";
import { InlineKeyboard } from "grammy";
import type { Env } from "@/types";

// ── 邮件信息键盘（星标 / 查看原文）─────────────────────────────────────────

/** 星标 inline keyboard（无查看原文按钮） */
export function starKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("keyboards:mail.star"), "star")
    .text(t("keyboards:mail.junk"), "junk_mark")
    .text(t("keyboards:mail.archive"), "archive")
    .text(t("keyboards:mail.refresh"), "refresh");
}

export function starredKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("keyboards:mail.starred"), "unstar")
    .text(t("keyboards:mail.junk"), "junk_mark")
    .text(t("keyboards:mail.archive"), "archive")
    .text(t("keyboards:mail.refresh"), "refresh");
}

/** 创建带"查看原文"链接的星标键盘 */
export function starKeyboardWithMailUrl(mailUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("keyboards:mail.star"), "star")
    .text(t("keyboards:mail.junk"), "junk_mark")
    .text(t("keyboards:mail.archive"), "archive")
    .text(t("keyboards:mail.refresh"), "refresh")
    .row()
    .url(t("keyboards:mail.viewOriginal"), mailUrl);
}

export function starredKeyboardWithMailUrl(mailUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("keyboards:mail.starred"), "unstar")
    .text(t("keyboards:mail.junk"), "junk_mark")
    .text(t("keyboards:mail.archive"), "archive")
    .text(t("keyboards:mail.refresh"), "refresh")
    .row()
    .url(t("keyboards:mail.viewOriginal"), mailUrl);
}

/** 根据星标状态构建邮件消息键盘 */
export async function buildEmailKeyboard(
  env: Env,
  emailMessageId: string,
  accountId: number,
  starred: boolean,
): Promise<InlineKeyboard> {
  if (env.WORKER_URL) {
    const mailToken = await generateMailTokenById(
      env.ADMIN_SECRET,
      emailMessageId,
      accountId,
    );
    const mailUrl = `${env.WORKER_URL.replace(/\/$/, "")}/mail/${emailMessageId}?accountId=${accountId}&t=${mailToken}`;
    return starred
      ? starredKeyboardWithMailUrl(mailUrl)
      : starKeyboardWithMailUrl(mailUrl);
  }
  return starred ? starredKeyboard() : starKeyboard();
}

/** 从邮件源查询当前星标状态后构建键盘（LLM 处理后编辑消息使用） */
export async function resolveStarredKeyboard(
  env: Env,
  chatId: string,
  tgMessageId: number,
  emailMessageId: string,
  accountId: number,
): Promise<InlineKeyboard> {
  const mapping = await getMessageMapping(env.DB, chatId, tgMessageId);
  if (!mapping)
    return buildEmailKeyboard(env, emailMessageId, accountId, false);
  const account = await getAccountById(env.DB, mapping.account_id);
  if (!account)
    return buildEmailKeyboard(env, emailMessageId, accountId, false);
  const provider = getEmailProvider(account, env);
  const starred = await provider.isStarred(emailMessageId);
  return buildEmailKeyboard(env, emailMessageId, accountId, starred);
}

// ── 主菜单键盘 ──────────────────────────────────────────────────────────────

/** 主菜单键盘 */
export function mainMenuKeyboard(admin: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(t("keyboards:menu.accountManagement"), "accs")
    .row()
    .text(t("keyboards:menu.unread"), "unread")
    .text(t("keyboards:menu.sync"), "sync")
    .row()
    .text(t("keyboards:menu.starred"), "starred")
    .text(t("keyboards:menu.junk"), "junk")
    .row()
    .text(t("keyboards:menu.archived"), "archived")
    .row();
  if (admin) {
    kb.text(t("keyboards:menu.userManagement"), "users")
      .text(t("keyboards:menu.globalOps"), "admin")
      .row();
  }
  return kb;
}
