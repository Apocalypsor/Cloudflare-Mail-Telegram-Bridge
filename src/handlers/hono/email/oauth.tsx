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
  PARAM_PROVIDER,
  ROUTE_OAUTH_CALLBACK,
  ROUTE_OAUTH_SETUP,
  ROUTE_OAUTH_START,
} from "@handlers/hono/routes";
import { PROVIDERS } from "@providers";
import type { OAuthHandler } from "@providers/base";
import { Api } from "grammy";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AccountType, AppEnv } from "@/types";

/** 从 URL path param 解析对应 provider 的 OAuth handler（未知 / 无 OAuth → null） */
function resolveOAuthFromUrl(c: Context<AppEnv>): OAuthHandler | null {
  const slug = c.req.param(PARAM_PROVIDER) as AccountType | undefined;
  return (slug && PROVIDERS[slug]?.oauth) || null;
}

const oauth = new Hono<AppEnv>();

oauth.get(ROUTE_OAUTH_SETUP, async (c) => {
  if (!resolveOAuthFromUrl(c)) return c.text("Unknown OAuth provider", 404);

  const accountId = parseInt(c.req.query("account") || "0", 10);
  if (Number.isNaN(accountId) || accountId <= 0)
    return c.text("Invalid account ID", 400);
  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return c.text("Account not found", 404);

  // setup page 本身命中 /oauth/:provider，start / callback 就在同级子路径
  const url = new URL(c.req.url);
  const startUrl = new URL(`${url.pathname}/start`, url.origin);
  startUrl.searchParams.set("account", String(account.id));
  const callbackUrl = `${url.origin}${url.pathname}/callback`;

  return c.html(
    <OAuthSetupPage
      startUrl={startUrl.toString()}
      callbackUrl={callbackUrl}
      accountEmail={account.email || `Account #${account.id}`}
    />,
  );
});

oauth.get(ROUTE_OAUTH_START, async (c) => {
  const oauthHandler = resolveOAuthFromUrl(c);
  if (!oauthHandler) return c.text("Unknown OAuth provider", 404);

  const accountId = parseInt(c.req.query("account") || "0", 10);
  if (Number.isNaN(accountId) || accountId <= 0)
    return c.text("Invalid account ID", 400);
  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return c.text("Account not found", 404);

  return oauthHandler.startOAuth(c.req.raw, c.env, account.id);
});

oauth.get(ROUTE_OAUTH_CALLBACK, async (c) => {
  const oauthHandler = resolveOAuthFromUrl(c);
  if (!oauthHandler) return c.text("Unknown OAuth provider", 404);

  const result = await oauthHandler.processOAuthCallback(c.req.raw, c.env);
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
      /* best-effort: don't break OAuth success page */
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

export default oauth;
