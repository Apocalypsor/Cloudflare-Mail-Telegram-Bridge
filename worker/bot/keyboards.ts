import { getBotInfo } from "@bot/index";
import { countPendingRemindersForEmail } from "@db/reminders";
import { t } from "@i18n";
import {
  buildMiniAppMailUrl,
  buildMiniAppRemindersUrl,
  buildWebMailUrl,
  generateMailTokenById,
} from "@utils/mail-token";
import { InlineKeyboard } from "grammy";
import type { Env } from "@/types";

// ── 邮件信息键盘（星标 / 查看原文）─────────────────────────────────────────

/**
 * 第一次发送邮件时挂的最小键盘 —— 只带一个刷新键。
 *
 * `buildEmailKeyboard` 要求 `tgMessageId` 才能构造群聊 Mini App deep link，
 * 但 send 之前我们没有 tgMessageId。所以投递流程是：先裸发（带这个初始
 * 键盘）→ 拿到 sentMessageId → `buildEmailKeyboard` + `setReplyMarkup`
 * 升级成完整键盘。万一升级那步失败，用户至少还有刷新键能手动触发重建
 * （`bot/handlers/refresh.ts` 会跑 `refreshEmail`，最终再打一遍完整键盘）。
 */
export function buildInitialEmailKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(t("keyboards:mail.refresh"), "refresh");
}

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
 * 构建邮件消息的完整 inline keyboard。**必须在 send 之后调用**（需要 tgMessageId
 * 才能给群聊构造 Mini App deep link）。投递流程是：先 sendTextMessage/
 * sendWithAttachments 裸发文本拿到 sentMessageId，再 buildEmailKeyboard +
 * setReplyMarkup —— 这样群聊和私聊只有一条路径。
 *
 * ⏰ / 👁 Mini App 入口：
 * - 私聊：inline `web_app` 按钮直传子页面 URL（带 accountId/emailMessageId/token）
 * - 群聊：`web_app` 在群里无效（BUTTON_TYPE_INVALID），改用 deep link
 *   `t.me/<bot>/<short>?startapp=<feature>_<chatId>_<tgMsgId>`
 *   start_param 由 Mini App 调 resolve-context 接口换出 (accountId, emailMessageId, token)。
 *   需要配 `TG_MINI_APP_SHORT_NAME` + BotFather `/newapp`。
 *   未配置时群聊的 ⏰/👁 退化成裸 web URL（无 Mini App 能力）。
 */
export async function buildEmailKeyboard(
  env: Env,
  emailMessageId: string,
  accountId: number,
  starred: boolean,
  canArchive: boolean,
  chatId: string,
  tgMessageId: number,
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

  // 👁 / ⏰ 都走 Mini App ——`web_app` 按钮在所有平台 (macos / tdesktop /
  // ios / android) 都直接在 Mini App 内打开；不再做桌面跳浏览器的分流。
  // ⏰ 设提醒本来就需要 TG context，所以也只能是 Mini App。
  const miniAppMailUrl = buildMiniAppMailUrl(
    base,
    emailMessageId,
    accountId,
    mailToken,
  );

  // 私聊：直接用 Mini App URL（web_app inline button 仅私聊有效）
  if (!chatId.startsWith("-")) {
    kb.row()
      .webApp(
        remindBtn,
        buildMiniAppRemindersUrl(base, emailMessageId, accountId, mailToken),
      )
      .webApp(viewLabel, miniAppMailUrl);
    return kb;
  }

  // 群聊：走 `t.me/<bot>/<short>?startapp=<feature>_<chat>_<msg>` deep link
  // （web_app 在群里无效，必须走 deep link 拉起 Mini App）。
  // getBotInfo 在 module 顶层做了 isolate-scope memoize，跟 webhook 入口
  // 共享同一份缓存，这里不会触发额外 KV read。cache miss + Telegram API
  // getMe 失败时退化为 null —— 群聊降级成裸 web 链接，而不是整条键盘构建
  // 炸掉。
  const shortName = env.TG_MINI_APP_SHORT_NAME;
  const username = shortName
    ? await getBotInfo(env)
        .then((info) => info.username)
        .catch(() => null)
    : null;
  if (shortName && username) {
    const deepLink = (feature: "r" | "m") =>
      `https://t.me/${username}/${shortName}?startapp=${feature}_${chatId}_${tgMessageId}`;
    kb.row().url(remindBtn, deepLink("r")).url(viewLabel, deepLink("m"));
    return kb;
  }
  // 未配 Mini App short name：群聊降级到裸 web 链接（无 ⏰ 能力）
  kb.row().url(
    viewLabel,
    buildWebMailUrl(base, emailMessageId, accountId, mailToken),
  );
  return kb;
}
