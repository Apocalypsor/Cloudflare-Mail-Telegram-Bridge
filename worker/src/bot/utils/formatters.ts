import { t } from "@worker/i18n";
import { PROVIDERS } from "@worker/providers";
import type { Account } from "@worker/types";
import { InlineKeyboard } from "grammy";

export function accountDetailText(
  account: Account,
  ownerName?: string,
): string {
  const klass = PROVIDERS[account.type];
  let text = `${t("accounts:detail.title", { id: account.id })}\n\n`;
  if (account.disabled) {
    text += `${t("common:status.disabled")}\n\n`;
  }
  text += `${t("accounts:detail.typeLabel", { type: klass.displayName })}\n`;
  text += `${t("accounts:detail.email", { email: account.email || t("common:label.notSet") })}\n`;
  text += `Chat ID: ${account.chat_id}\n`;
  if (klass.oauth) {
    const status = account.refresh_token
      ? t("common:status.authorized")
      : t("common:status.notAuthorized");
    text += t("accounts:detail.status", { status });
  } else {
    // 非 OAuth（IMAP）：显示服务器 / 用户名
    text += `${t("accounts:detail.server", { server: `${account.imap_host}:${account.imap_port}${account.imap_secure ? " (TLS)" : ""}` })}\n`;
    text += t("accounts:detail.username", { user: account.imap_user });
  }
  // 需要让用户手动配置归档目标的 provider（目前只有 Gmail）才展示这行
  if (klass.needsArchiveSetup) {
    const archiveLabel =
      account.archive_folder_name ||
      account.archive_folder ||
      t("common:label.notSet");
    text += `\n${t("archive:gmailLabelLine", { label: archiveLabel })}`;
  }
  if (ownerName !== undefined) {
    text += `\n${t("accounts:detail.owner", { name: ownerName || t("common:label.none") })}`;
  }
  return text;
}

export function accountDetailKeyboard(account: Account): InlineKeyboard {
  const klass = PROVIDERS[account.type];
  const kb = new InlineKeyboard();
  const toggleLabel = account.disabled
    ? t("accounts:button.enable")
    : t("accounts:button.disable");
  if (klass.oauth) {
    const authLabel = account.refresh_token
      ? t("accounts:button.reauthorize")
      : t("accounts:button.authorize");
    kb.text(authLabel, `acc:${account.id}:auth`);
    if (account.refresh_token) {
      kb.text("🔄 Watch", `acc:${account.id}:w`);
    }
    kb.row();
    kb.text(t("accounts:button.edit"), `acc:${account.id}:edit`);
    // 需要用户手动选归档标签的 provider（Gmail）才显示这个按钮
    if (account.refresh_token && klass.needsArchiveSetup) {
      kb.text(t("archive:gmailLabelButton"), `acc:${account.id}:arc`);
    }
    kb.row();
    kb.text(toggleLabel, `acc:${account.id}:t`);
    kb.text(t("accounts:button.delete"), `acc:${account.id}:del`);
    kb.row();
    kb.text(t("common:button.backToAccounts"), "accs");
  } else {
    kb.text(t("accounts:button.edit"), `acc:${account.id}:edit`);
    kb.text(toggleLabel, `acc:${account.id}:t`).row();
    kb.text(t("accounts:button.delete"), `acc:${account.id}:del`).row();
    kb.text(t("common:button.backToAccounts"), "accs");
  }
  return kb;
}

export function formatUserName(user: {
  first_name: string;
  last_name?: string | null;
}): string {
  return user.first_name + (user.last_name ? ` ${user.last_name}` : "");
}
