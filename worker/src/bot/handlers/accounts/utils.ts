import { isAdmin } from "@worker/bot/utils/auth";
import { formatUserName } from "@worker/bot/utils/formatters";
import { getAuthorizedAccount } from "@worker/db/accounts";
import { getUserByTelegramId } from "@worker/db/users";
import { t } from "@worker/i18n";
import { PROVIDERS } from "@worker/providers";
import type { Account, Env } from "@worker/types";
import { InlineKeyboard } from "grammy";

/**
 * 解析账号所有者名称用于详情页 owner 行：
 * - 非管理员 → 返回 undefined（不显示 owner 行）
 * - 管理员 + account 无绑定 user → 返回 ""（显示"(无)"）
 * - 管理员 + 能查到 user → 优先 @username，否则用 formatUserName
 */
export async function resolveOwnerName(
  db: D1Database,
  admin: boolean,
  telegramUserId: string | null,
): Promise<string | undefined> {
  if (!admin) return undefined;
  if (!telegramUserId) return "";
  const owner = await getUserByTelegramId(db, telegramUserId);
  return owner?.username
    ? `@${owner.username}`
    : formatUserName(owner ?? { first_name: telegramUserId });
}

export async function resolveAccount(
  env: Env,
  fromId: number,
  accountIdStr: string,
) {
  const userId = String(fromId);
  const accountId = parseInt(accountIdStr, 10);
  const admin = isAdmin(userId, env);
  const account = await getAuthorizedAccount(env.DB, accountId, userId, admin);
  return { userId, accountId, admin, account };
}

export function accountListKeyboard(
  accounts: Account[],
  options?: { isAdmin?: boolean; showAll?: boolean; showBack?: boolean },
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const acc of accounts) {
    // 禁用 > 非 OAuth（IMAP 等，直接视为可用）> OAuth 授权状态
    const status = acc.disabled
      ? "⏸"
      : !PROVIDERS[acc.type].oauth
        ? "📬"
        : acc.refresh_token
          ? "✅"
          : "❌";
    const display = acc.email || `#${acc.id}`;
    kb.text(`${status} ${display}`, `acc:${acc.id}`).row();
  }
  kb.text(t("accounts:list.addAccount"), "add").row();
  if (options?.isAdmin) {
    const back = options.showBack ? "" : ":s";
    kb.text(
      options.showAll
        ? t("accounts:list.collapse")
        : t("accounts:list.viewAll"),
      options.showAll ? `accs${back}` : `accs:all${back}`,
    ).row();
  }
  if (options?.showBack) kb.text(t("common:button.back"), "menu");
  return kb;
}
