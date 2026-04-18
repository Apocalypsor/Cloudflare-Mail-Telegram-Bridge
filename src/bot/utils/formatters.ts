import { t } from "@i18n";
import { InlineKeyboard } from "grammy";
import type { Account, TelegramUser } from "@/types";
import { AccountType } from "@/types";

export function accountDetailText(
  account: Account,
  ownerName?: string,
): string {
  let text = `${t("accounts:detail.title", { id: account.id })}\n\n`;
  if (account.type === AccountType.Imap) {
    text += `${t("accounts:detail.typeLabel", { type: t("accounts:detail.typeImap") })}\n`;
    text += `${t("accounts:detail.email", { email: account.email || t("common:label.notSet") })}\n`;
    text += `Chat ID: ${account.chat_id}\n`;
    text += `${t("accounts:detail.server", { server: `${account.imap_host}:${account.imap_port}${account.imap_secure ? " (TLS)" : ""}` })}\n`;
    text += t("accounts:detail.username", { user: account.imap_user });
  } else {
    const status = account.refresh_token
      ? t("common:status.authorized")
      : t("common:status.notAuthorized");
    const typeName =
      account.type === AccountType.Outlook
        ? t("accounts:detail.typeOutlook")
        : t("accounts:detail.typeGmail");
    text += `${t("accounts:detail.typeLabel", { type: typeName })}\n`;
    text += `${t("accounts:detail.email", { email: account.email || t("common:label.notSet") })}\n`;
    text += `Chat ID: ${account.chat_id}\n`;
    text += t("accounts:detail.status", { status });
  }
  if (account.type === AccountType.Gmail) {
    text += `\n${t("archive:gmailLabelLine", { label: account.archive_folder || t("common:label.notSet") })}`;
  }
  if (ownerName !== undefined) {
    text += `\n${t("accounts:detail.owner", { name: ownerName || t("common:label.none") })}`;
  }
  return text;
}

export function accountDetailKeyboard(account: Account): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (account.type === AccountType.Imap) {
    kb.text(t("accounts:button.edit"), `acc:${account.id}:edit`).row();
    kb.text(t("accounts:button.delete"), `acc:${account.id}:del`).row();
    kb.text(t("common:button.backToAccounts"), "accs");
  } else {
    const authLabel = account.refresh_token
      ? t("accounts:button.reauthorize")
      : t("accounts:button.authorize");
    kb.text(authLabel, `acc:${account.id}:auth`);
    if (account.refresh_token) {
      kb.text("🔄 Watch", `acc:${account.id}:w`);
    }
    kb.row();
    kb.text(t("accounts:button.edit"), `acc:${account.id}:edit`);
    if (account.type === AccountType.Gmail && account.refresh_token) {
      kb.text(t("archive:gmailLabelButton"), `acc:${account.id}:arc`);
    }
    kb.row();
    kb.text(t("accounts:button.delete"), `acc:${account.id}:del`);
    kb.row();
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

export function userListText(users: TelegramUser[]): string {
  if (users.length === 0) return t("admin:users.noUsers");

  let text = `${t("admin:users.title", { count: users.length })}\n\n`;
  for (const u of users) {
    const status = u.approved === 1 ? "✅" : "⏳";
    const name = formatUserName(u);
    const username = u.username ? ` @${u.username}` : "";
    text += `${status} ${name}${username}\n   ID: ${u.telegram_id}\n`;
  }
  return text;
}
