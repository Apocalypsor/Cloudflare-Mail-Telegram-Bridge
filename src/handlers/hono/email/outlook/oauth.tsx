import {
  accountDetailKeyboard,
  accountDetailText,
} from "@bot/utils/formatters";
import {
  OAuthCallbackPage,
  OAuthErrorPage,
  OAuthSetupPage,
} from "@components/oauth";
import { getAccountById } from "@db/accounts";
import { deleteOAuthBotMsg, getOAuthBotMsg } from "@db/kv";
import {
  ROUTE_OAUTH_MICROSOFT,
  ROUTE_OAUTH_MICROSOFT_CALLBACK,
  ROUTE_OAUTH_MICROSOFT_START,
} from "@handlers/hono/routes";
import {
  getOAuthPageProps,
  processOAuthCallback,
  startMicrosoftOAuth,
} from "@services/email/outlook/oauth";
import { Api } from "grammy";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "@/types";

const msOauth = new Hono<AppEnv>();

msOauth.get(ROUTE_OAUTH_MICROSOFT, async (c) => {
  const accountId = parseInt(c.req.query("account") || "0", 10);
  if (Number.isNaN(accountId) || accountId <= 0)
    return c.text("Invalid account ID", 400);
  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return c.text("Account not found", 404);

  const props = getOAuthPageProps(
    c.req.raw,
    account.id,
    account.email || `Account #${account.id}`,
  );
  return c.html(<OAuthSetupPage {...props} provider="Microsoft" />);
});

msOauth.get(ROUTE_OAUTH_MICROSOFT_START, async (c) => {
  const accountId = parseInt(c.req.query("account") || "0", 10);
  if (Number.isNaN(accountId) || accountId <= 0)
    return c.text("Invalid account ID", 400);
  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return c.text("Account not found", 404);

  return startMicrosoftOAuth(c.req.raw, c.env, account.id);
});

msOauth.get(ROUTE_OAUTH_MICROSOFT_CALLBACK, async (c) => {
  const result = await processOAuthCallback(c.req.raw, c.env);
  if (!result.ok) {
    return c.html(
      <OAuthErrorPage title={result.title} detail={result.detail} />,
      result.status as ContentfulStatusCode,
    );
  }

  // 尝试更新 bot 中的授权消息
  const botMsg = await getOAuthBotMsg(c.env.EMAIL_KV, result.accountId);
  if (botMsg) {
    try {
      const account = await getAccountById(c.env.DB, result.accountId);
      if (account) {
        const api = new Api(c.env.TELEGRAM_BOT_TOKEN);
        await api.editMessageText(
          botMsg.chatId,
          botMsg.messageId,
          accountDetailText(account),
          {
            reply_markup: accountDetailKeyboard(account),
          },
        );
      }
    } catch {
      /* best-effort */
    }
    await deleteOAuthBotMsg(c.env.EMAIL_KV, result.accountId);
  }

  return c.html(
    <OAuthCallbackPage
      refreshToken={result.refreshToken}
      scope={result.scope}
      expiresIn={result.expiresIn}
      accountEmail={result.accountEmail}
    />,
  );
});

export default msOauth;
