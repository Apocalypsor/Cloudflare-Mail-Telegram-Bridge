import { getAllAccounts } from "@worker/db/accounts";
import type { EmailProvider } from "@worker/providers/base";
import { GmailProvider } from "@worker/providers/gmail";
import { ImapProvider } from "@worker/providers/imap";
import { OutlookProvider } from "@worker/providers/outlook";
import type { EmailProviderClass } from "@worker/providers/types";
import { type Account, AccountType, type Env } from "@worker/types";

export { EmailProvider } from "@worker/providers/base";
export { GmailProvider } from "@worker/providers/gmail";
export { ImapProvider } from "@worker/providers/imap";
export { OutlookProvider } from "@worker/providers/outlook";
export type {
  EmailListItem,
  EmailProviderClass,
  OAuthHandler,
  OAuthProviderConfig,
  OAuthTokenResponse,
  PreviewContent,
} from "@worker/providers/types";

/**
 * AccountType → provider class 的唯一映射。新增 provider 在这加一行。
 * URL slug `/oauth/:provider/*` 里的 `:provider` 就是 AccountType 的值。
 * 访问 OAuth handler：`PROVIDERS[type].oauth`（IMAP 为 undefined）。
 */
export const PROVIDERS: Record<AccountType, EmailProviderClass> = {
  [AccountType.Gmail]: GmailProvider,
  [AccountType.Outlook]: OutlookProvider,
  [AccountType.Imap]: ImapProvider,
};

/** 按 account 实例化对应的 EmailProvider 子类 */
export function getEmailProvider(account: Account, env: Env): EmailProvider {
  return new PROVIDERS[account.type](account, env);
}

/**
 * 根据 account 判断能否执行归档（不需要实例化 provider 就能问）。
 * 委派到 provider class 的静态 `canArchive`，默认 true；Gmail override 需要 archive label。
 */
export function accountCanArchive(account: Account): boolean {
  return PROVIDERS[account.type].canArchive(account);
}

/** 为所有已授权且未禁用的账号续订推送通知 */
export async function renewAllPush(env: Env): Promise<void> {
  const accounts = await getAllAccounts(env.DB);
  for (const account of accounts) {
    if (account.disabled) {
      console.log(`Skipping push renewal for ${account.email}: disabled`);
      continue;
    }
    if (!account.refresh_token) {
      console.log(
        `Skipping push renewal for ${account.email}: no refresh token`,
      );
      continue;
    }
    const provider = getEmailProvider(account, env);
    await provider.renewPush();
  }
}
