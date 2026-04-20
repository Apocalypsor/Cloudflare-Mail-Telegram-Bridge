import { getCachedBotInfo } from "@db/kv";
import { ROUTE_MINI_APP } from "@handlers/hono/routes";
import { t } from "@i18n";
import { generateMailTokenById } from "@services/mail-preview";
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

  const base = env.WORKER_URL.replace(/\/$/, "");
  const mailToken = await generateMailTokenById(
    env.ADMIN_SECRET,
    emailMessageId,
    accountId,
  );
  const mailUrl = `${base}/mail/${emailMessageId}?accountId=${accountId}&t=${mailToken}`;
  const isPrivateChat = !chatId.startsWith("-");

  if (isPrivateChat) {
    const remindUrl = `${base}${ROUTE_MINI_APP}?accountId=${accountId}&messageId=${encodeURIComponent(emailMessageId)}&token=${mailToken}`;
    kb.row()
      .webApp(t("keyboards:mail.remind"), remindUrl)
      .url(t("keyboards:mail.viewOriginal"), mailUrl);
    return kb;
  }

  // 群聊场景：要走 BotFather 注册的具名 Mini App。`?startapp=` 不带 short_name
  // 只对默认 Mini App 有效；具名 app 必须用 `t.me/<bot>/<short_name>?startapp=...`
  // 否则 TG 客户端报 BOT_INVALID。
  const shortName = env.TG_MINI_APP_SHORT_NAME;
  if (tgMessageId != null && shortName) {
    const username = await getCachedBotUsername(env);
    if (username) {
      // start_param 允许 [A-Za-z0-9_-]，max 64：chatId 形如 -1001234567890，
      // 拼上 _<msgId> 也就 ~20 字符，远低于上限
      const startParam = `${chatId}_${tgMessageId}`;
      const remindUrl = `https://t.me/${username}/${shortName}?startapp=${startParam}`;
      kb.row()
        .url(t("keyboards:mail.remind"), remindUrl)
        .url(t("keyboards:mail.viewOriginal"), mailUrl);
      return kb;
    }
  }
  // 群聊但 tgMessageId 未知 / 没缓存到 bot username / 没配 short_name：暂不放 ⏰
  kb.row().url(t("keyboards:mail.viewOriginal"), mailUrl);
  return kb;
}

// ── 主菜单键盘 ──────────────────────────────────────────────────────────────

/** 主菜单键盘 */
export function mainMenuKeyboard(admin: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(t("keyboards:menu.accountManagement"), "accs")
    .row()
    .text(t("keyboards:menu.unread"), "unread")
    .text(t("keyboards:menu.starred"), "starred")
    .row()
    .text(t("keyboards:menu.junk"), "junk")
    .text(t("keyboards:menu.archived"), "archived")
    .row()
    .text(t("keyboards:menu.sync"), "sync")
    .row();
  if (admin) {
    kb.text(t("keyboards:menu.userManagement"), "users")
      .text(t("keyboards:menu.globalOps"), "admin")
      .row();
  }
  return kb;
}
