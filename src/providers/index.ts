import { getAllAccounts } from "@db/accounts";
import type {
  EmailProvider,
  EmailProviderClass,
  OAuthHandler,
} from "@providers/base";
import { GmailProvider } from "@providers/gmail";
import { ImapProvider } from "@providers/imap";
import { OutlookProvider } from "@providers/outlook";
import { type Account, AccountType, type Env } from "@/types";

export {
  type EmailListItem,
  EmailProvider,
  type EmailProviderClass,
} from "@providers/base";
export { GmailProvider } from "@providers/gmail";
export { ImapProvider } from "@providers/imap";
export { OutlookProvider } from "@providers/outlook";

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

/** 拿到某 provider 的 OAuth handler，不支持 OAuth（IMAP）→ 抛错 */
export function oauthOf(type: AccountType): OAuthHandler {
  const oauth = PROVIDERS[type].oauth;
  if (!oauth) throw new Error(`${type} does not support OAuth`);
  return oauth;
}

/** 为所有已授权账号续订推送通知 */
export async function renewAllPush(env: Env): Promise<void> {
  const accounts = await getAllAccounts(env.DB);
  for (const account of accounts) {
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
