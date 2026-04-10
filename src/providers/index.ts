import { getAllAccounts } from "@db/accounts";
import type { EmailProvider } from "@providers/base";
import { GmailProvider } from "@providers/gmail";
import { ImapProvider } from "@providers/imap";
import { OutlookProvider } from "@providers/outlook";
import { type Account, AccountType, type Env } from "@/types";

export { type EmailListItem, EmailProvider } from "@providers/base";
export { GmailProvider } from "@providers/gmail";
export { ImapProvider } from "@providers/imap";
export { OutlookProvider } from "@providers/outlook";

export function getEmailProvider(account: Account, env: Env): EmailProvider {
  if (account.type === AccountType.Imap) return new ImapProvider(account, env);
  if (account.type === AccountType.Outlook)
    return new OutlookProvider(account, env);
  return new GmailProvider(account, env);
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
