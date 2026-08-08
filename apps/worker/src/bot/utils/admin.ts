import { ROUTE_MINI_APP_USERS } from "@page/paths";
import { groupMiniAppUrl } from "@worker/bot/utils/miniapp-menu";
import { countFailedEmails, type FailedEmail } from "@worker/db/failed-emails";
import { t } from "@worker/i18n";
import type { Env } from "@worker/types";
import { escapeMdV2 } from "@worker/utils/markdown-v2";
import { escapeBackslashAndBacktick } from "@worker/utils/string";
import { getWorkerBaseUrl } from "@worker/utils/url";
import { InlineKeyboard } from "grammy";

export const SECRETS_AUTO_DELETE_SECONDS = 20;

type ChatType = "private" | "group" | "supergroup" | "channel" | undefined;

export const adminMenuKeyboard = async (
  env: Env,
  chatType: ChatType,
  botUsername: string,
): Promise<InlineKeyboard> => {
  const failedCount = await countFailedEmails(env.DB);
  const base = getWorkerBaseUrl(env);
  const userManagementUrl = `${base}${ROUTE_MINI_APP_USERS}`;
  const failedLabel =
    failedCount > 0
      ? t("admin:failedEmails.titleWithCount", { count: failedCount })
      : t("admin:failedEmails.title");
  const kb = new InlineKeyboard();
  if (chatType === "private") {
    kb.webApp(t("keyboards:menu.userManagement"), userManagementUrl);
  } else {
    kb.url(
      t("keyboards:menu.userManagement"),
      groupMiniAppUrl(env, botUsername)("p_users", userManagementUrl),
    );
  }
  kb.row()
    .text(failedLabel, "failed")
    .row()
    .text(t("admin:renewWatch"), "walla")
    .row()
    .text(t("admin:secrets.button"), "secrets")
    .row();
  kb.url(t("admin:htmlPreview"), `${base}/preview`).row();
  kb.url(t("admin:junkCheck"), `${base}/junk-check`).row();
  kb.text(t("common:button.back"), "menu");
  return kb;
};

export const buildSecretsText = (env: Env): string => {
  const secrets: Array<{ label: string; value: string }> = [
    { label: "TELEGRAM_WEBHOOK_SECRET", value: env.TELEGRAM_WEBHOOK_SECRET },
    { label: "ADMIN_SECRET", value: env.ADMIN_SECRET },
    { label: "ADMIN_TELEGRAM_ID", value: env.ADMIN_TELEGRAM_ID },
  ];

  const lines: string[] = [`*${escapeMdV2(t("admin:secrets.title"))}*`];
  for (const { label, value } of secrets) {
    lines.push(
      ``,
      escapeMdV2(label),
      `\`${escapeBackslashAndBacktick(value)}\``,
    );
  }
  const url = `${getWorkerBaseUrl(env)}/api/telegram/webhook?secret=${env.TELEGRAM_WEBHOOK_SECRET}`;
  lines.push(
    ``,
    escapeMdV2(t("admin:secrets.webhookUrlLabel")),
    `\`${escapeBackslashAndBacktick(url)}\``,
  );

  lines.push(
    ``,
    t("admin:secrets.autoDeleteHint", {
      seconds: SECRETS_AUTO_DELETE_SECONDS,
    }),
  );
  return lines.join("\n");
};

export const failedEmailListMessage = (
  items: FailedEmail[],
): {
  text: string;
  keyboard: InlineKeyboard;
} => {
  if (items.length === 0) {
    return {
      text: t("admin:failedEmails.noRecords"),
      keyboard: new InlineKeyboard().text(t("common:button.back"), "admin"),
    };
  }
  const lines = items.map((item, i) => {
    const date = item.created_at.toISOString().replace("T", " ").slice(0, 16);
    const subj = item.subject
      ? item.subject.length > 30
        ? `${item.subject.slice(0, 30)}…`
        : item.subject
      : t("common:label.noSubjectParen");
    return `${i + 1}. ${subj}\n   ${date} | ${item.error_message?.slice(0, 40) || t("common:error.unknownError")}`;
  });
  const kb = new InlineKeyboard()
    .text(t("admin:failedEmails.retryAll"), "retry_all")
    .text(t("admin:failedEmails.clearAll"), "failed_clear")
    .row();
  for (const item of items) {
    const label = item.subject
      ? item.subject.length > 15
        ? `${item.subject.slice(0, 15)}…`
        : item.subject
      : `#${item.id}`;
    kb.text(`🔄 ${label}`, `fr:${item.id}`).text("🗑", `fd:${item.id}`).row();
  }
  kb.text(t("common:button.back"), "admin");
  return {
    text: `${t("admin:failedEmails.titleWithCount", { count: items.length })}\n\n${lines.join("\n\n")}`,
    keyboard: kb,
  };
};
