import { getAllAccounts } from "@db/accounts";
import { GmailProvider } from "@services/email/gmail";
import { ImapProvider } from "@services/email/imap";
import { OutlookProvider } from "@services/email/outlook";
import type { EmailProvider } from "@services/email/provider";
import type { Account, Env } from "@/types";
import { AccountType } from "@/types";

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
