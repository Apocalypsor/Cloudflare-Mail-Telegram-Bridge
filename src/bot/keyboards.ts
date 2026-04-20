import { t } from "@i18n";
import { generateMailTokenById } from "@services/mail-preview";
import { InlineKeyboard } from "grammy";
import type { Env } from "@/types";

// ── 邮件信息键盘（星标 / 查看原文）─────────────────────────────────────────

function addCoreButtons(
  kb: InlineKeyboard,
  starred: boolean,
  canArchive: boolean,
): InlineKeyboard {
  kb.text(
    t(starred ? "keyboards:mail.starred" : "keyboards:mail.star"),
    starred ? "unstar" : "star",
  );
  kb.text(t("keyboards:mail.junk"), "junk_mark");
  if (canArchive) kb.text(t("keyboards:mail.archive"), "archive");
  kb.text(t("keyboards:mail.refresh"), "refresh");
  return kb;
}

/**
 * 从已有 reply_markup 推断当前星标状态 —— 读星按钮的 callback_data：
 * "star" 表示当前未星标（按钮动作是加星），"unstar" 表示当前已星标。
 * 用于在非星标场景（如 junk_cancel 还原键盘）避免查远端 `isStarred()`。
 */
export function readStarredFromReplyMarkup(replyMarkup: unknown): boolean {
  if (!replyMarkup || typeof replyMarkup !== "object") return false;
  const rows = (replyMarkup as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(rows)) return false;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const btn of row) {
      const data =
        btn && typeof btn === "object"
          ? (btn as { callback_data?: unknown }).callback_data
          : undefined;
      if (data === "unstar") return true;
      if (data === "star") return false;
    }
  }
  return false;
}

/** 根据星标状态构建邮件消息键盘 */
export async function buildEmailKeyboard(
  env: Env,
  emailMessageId: string,
  accountId: number,
  starred: boolean,
  canArchive: boolean,
): Promise<InlineKeyboard> {
  const kb = addCoreButtons(new InlineKeyboard(), starred, canArchive);
  if (env.WORKER_URL) {
    const mailToken = await generateMailTokenById(
      env.ADMIN_SECRET,
      emailMessageId,
      accountId,
    );
    const mailUrl = `${env.WORKER_URL.replace(/\/$/, "")}/mail/${emailMessageId}?accountId=${accountId}&t=${mailToken}`;
    kb.row().url(t("keyboards:mail.viewOriginal"), mailUrl);
  }
  return kb;
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
