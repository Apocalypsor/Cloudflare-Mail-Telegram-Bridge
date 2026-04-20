import { getCachedBotInfo } from "@db/kv";
import { countPendingRemindersForEmail } from "@db/reminders";
import {
  ROUTE_MINI_APP_LIST,
  ROUTE_MINI_APP_REMINDERS,
} from "@handlers/hono/routes";
import { t } from "@i18n";
import {
  buildMiniAppMailUrl,
  buildMiniAppRemindersUrl,
  buildWebMailUrl,
  generateMailTokenById,
} from "@services/mail-preview";
import { InlineKeyboard } from "grammy";
import type { Env } from "@/types";

/** 从 KV 缓存读 bot username（webhook 第一次请求会写入；不应缺失） */
async function getCachedBotUsername(env: Env): Promise<string | null> {
  const raw = await getCachedBotInfo(env.EMAIL_KV);
  if (!raw) return null;
  try {
    const info = JSON.parse(raw) as { username?: string };
    return info.username ?? null;
  } catch {
    return null;
  }
}

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

/** ⏰ 按钮 label：有待提醒就带数字 `⏰ (N)`，否则裸 emoji */
function remindLabel(count: number): string {
  const base = t("keyboards:mail.remind");
  return count > 0 ? `${base} (${count})` : base;
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

/**
 * 根据星标状态构建邮件消息键盘。
 *
 * ⏰ 提醒按钮的入口：
 * - 私聊：inline `web_app` 按钮直接打开 Mini App（带 accountId/messageId/token URL 参数）
 * - 群聊：inline `web_app` 在群里无效（BUTTON_TYPE_INVALID），改用 deep link
 *   `t.me/<bot>?startapp=<chatId>_<tgMsgId>` 跳到与 bot 的私聊里打开 Mini App，
 *   start_param 由 Mini App 调 resolve-context 接口换出 (accountId, messageId, token)。
 *   群聊场景需要 `tgMessageId`（消息 send 之后才知道）—— 投递初次构建键盘时
 *   传 undefined 即可（首次群聊消息不带 ⏰），后续 LLM 分析/refresh/star toggle
 *   走的 keyboard 重建路径都已知 tgMessageId，会补上 ⏰。
 */
export async function buildEmailKeyboard(
  env: Env,
  emailMessageId: string,
  accountId: number,
  starred: boolean,
  canArchive: boolean,
  chatId: string,
  tgMessageId?: number,
): Promise<InlineKeyboard> {
  const kb = addCoreButtons(new InlineKeyboard(), starred, canArchive);
  if (!env.WORKER_URL) return kb;

  const base = env.WORKER_URL;
  const [mailToken, reminderCount] = await Promise.all([
    generateMailTokenById(env.ADMIN_SECRET, emailMessageId, accountId),
    // ⏰ label 实时反映该邮件的 pending 提醒数（"⏰" 或 "⏰ (2)"）。
    countPendingRemindersForEmail(env.DB, accountId, emailMessageId),
  ]);
  const remindBtn = remindLabel(reminderCount);
  const viewLabel = t("keyboards:mail.viewOriginal");

  // 私聊：直接用 Mini App URL（web_app inline button 仅私聊有效）
  if (!chatId.startsWith("-")) {
    kb.row()
      .webApp(
        remindBtn,
        buildMiniAppRemindersUrl(base, emailMessageId, accountId, mailToken),
      )
      .webApp(
        viewLabel,
        buildMiniAppMailUrl(base, emailMessageId, accountId, mailToken),
      );
    return kb;
  }

  // 群聊：web_app inline button 在群里无效（BUTTON_TYPE_INVALID），改用
  // `t.me/<bot>/<shortname>?startapp=<feature>_<chat>_<msg>` deep link
  // 跳到与 bot 的私聊里打开 Mini App。
  // tgMessageId 在投递初次构建时还没分配，那种情况下退回到 web 预览链接。
  const shortName = env.TG_MINI_APP_SHORT_NAME;
  const username =
    tgMessageId != null && shortName ? await getCachedBotUsername(env) : null;
  if (tgMessageId != null && shortName && username) {
    const deepLink = (feature: "r" | "m") =>
      `https://t.me/${username}/${shortName}?startapp=${feature}_${chatId}_${tgMessageId}`;
    kb.row().url(remindBtn, deepLink("r")).url(viewLabel, deepLink("m"));
    return kb;
  }
  kb.row().url(
    viewLabel,
    buildWebMailUrl(base, emailMessageId, accountId, mailToken),
  );
  return kb;
}

// ── 主菜单键盘 ──────────────────────────────────────────────────────────────

/** 主菜单键盘 */
export function mainMenuKeyboard(admin: boolean, env: Env): InlineKeyboard {
  const kb = new InlineKeyboard();
  // 邮件列表 + 提醒：私聊里 web_app 直接打开 Mini App。
  // 没配 WORKER_URL 时回退到 callback（文本回复，靠 /unread 等命令）。
  // /start 默认私聊，inline web_app 在私聊有效。
  if (env.WORKER_URL) {
    const base = env.WORKER_URL.replace(/\/$/, "");
    const listUrl = (type: string) =>
      `${base}${ROUTE_MINI_APP_LIST.replace(":type", type)}`;
    kb.row()
      .webApp(t("keyboards:menu.unread"), listUrl("unread"))
      .webApp(t("keyboards:menu.starred"), listUrl("starred"))
      .row()
      .webApp(t("keyboards:menu.junk"), listUrl("junk"))
      .webApp(t("keyboards:menu.archived"), listUrl("archived"))
      .row()
      .webApp(
        t("keyboards:menu.reminders"),
        `${base}${ROUTE_MINI_APP_REMINDERS}`,
      );
  } else {
    kb.row()
      .text(t("keyboards:menu.unread"), "unread")
      .text(t("keyboards:menu.starred"), "starred")
      .row()
      .text(t("keyboards:menu.junk"), "junk")
      .text(t("keyboards:menu.archived"), "archived");
  }
  kb.row()
    .text(t("keyboards:menu.sync"), "sync")
    .text(t("keyboards:menu.accountManagement"), "accs")
    .row();
  if (admin) {
    kb.text(t("keyboards:menu.userManagement"), "users")
      .text(t("keyboards:menu.globalOps"), "admin")
      .row();
  }
  return kb;
}
