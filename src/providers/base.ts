import {
  getAccountById,
  updateAccountEmail,
  updateRefreshToken,
} from "@db/accounts";
import {
  deleteOAuthState,
  getOAuthState,
  putCachedAccessToken,
  putOAuthState,
} from "@db/kv";
import { http } from "@utils/http";
import { reportErrorToObservability } from "@utils/observability";
import type { Account, Env } from "@/types";

export interface EmailListItem {
  id: string;
  subject?: string;
}

export type OAuthTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type OAuthCallbackResult =
  | {
      ok: true;
      refreshToken: string | undefined;
      scope: string;
      expiresIn: number | undefined;
      accountEmail: string;
      accountId: number;
      ownerTelegramId: string | null;
    }
  | { ok: false; title: string; detail: string; status: number };

export interface OAuthProviderConfig {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  statePrefix: string;
  extraAuthorizeParams?: Record<string, string>;
  getCredentials(env: Env): { clientId: string; clientSecret: string };
  extraTokenBody?(env: Env): Record<string, string>;
  fetchEmail(accessToken: string): Promise<string | undefined>;
  onAuthorized(env: Env, account: Account): Promise<void>;
}

export abstract class EmailProvider {
  protected account: Account;
  protected env: Env;

  constructor(account: Account, env: Env) {
    this.account = account;
    this.env = env;
  }

  abstract markAsRead(messageId: string): Promise<void>;
  abstract addStar(messageId: string): Promise<void>;
  abstract removeStar(messageId: string): Promise<void>;
  abstract isStarred(messageId: string): Promise<boolean>;
  abstract isJunk(messageId: string): Promise<boolean>;
  abstract listUnread(maxResults?: number): Promise<EmailListItem[]>;
  abstract listStarred(maxResults?: number): Promise<EmailListItem[]>;
  abstract listJunk(maxResults?: number): Promise<EmailListItem[]>;
  abstract markAsJunk(messageId: string): Promise<void>;
  abstract moveToInbox(messageId: string): Promise<string>;
  abstract trashMessage(messageId: string): Promise<void>;
  abstract trashAllJunk(): Promise<number>;

  /**
   * 获取原始 MIME 邮件内容。
   * `folder` 仅 IMAP 使用（Gmail/Outlook 通过全局 messageId 定位，无需 folder）。
   */
  abstract fetchRawEmail(
    messageId: string,
    folder?: "inbox" | "junk",
  ): Promise<ArrayBuffer>;

  /** 注册/续订推送通知（Gmail watch / Outlook subscription） */
  async renewPush(): Promise<void> {}
  /** 停止推送通知 */
  async stopPush(): Promise<void> {}

  /** 解析推送通知并将新邮件入队，子类必须 override */
  static async enqueue(_body: unknown, _env: Env): Promise<void> {
    throw new Error("enqueue not implemented");
  }

  /** 基于 provider config 构造 OAuth 授权流程的 handler（开始 / 回调） */
  static createOAuthHandler(config: OAuthProviderConfig) {
    async function generateOAuthUrl(
      env: Env,
      accountId: number,
      callbackUrl: string,
    ): Promise<string> {
      const state = crypto.randomUUID();
      await putOAuthState(env.EMAIL_KV, config.statePrefix, state, accountId);

      const { clientId } = config.getCredentials(env);
      const authUrl = new URL(config.authorizeUrl);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", callbackUrl);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", config.scope);
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("state", state);
      for (const [k, v] of Object.entries(config.extraAuthorizeParams ?? {})) {
        authUrl.searchParams.set(k, v);
      }

      return authUrl.toString();
    }

    async function startOAuth(
      request: Request,
      env: Env,
      accountId: number,
    ): Promise<Response> {
      // start 路由命中 /oauth/:provider/start，callback 就是把 /start 换成 /callback
      const url = new URL(request.url);
      const callbackUrl = `${url.origin}${url.pathname.replace(/\/start$/, "/callback")}`;
      const authorizeUrl = await generateOAuthUrl(env, accountId, callbackUrl);
      return Response.redirect(authorizeUrl, 302);
    }

    async function processOAuthCallback(
      request: Request,
      env: Env,
    ): Promise<OAuthCallbackResult> {
      const requestUrl = new URL(request.url);
      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");
      const oauthError = requestUrl.searchParams.get("error");

      if (oauthError) {
        return {
          ok: false,
          title: `${config.name} OAuth 授权失败`,
          detail:
            requestUrl.searchParams.get("error_description") || oauthError,
          status: 400,
        };
      }

      if (!code || !state) {
        return {
          ok: false,
          title: "参数缺失",
          detail: "回调中没有 code 或 state。",
          status: 400,
        };
      }

      const accountIdStr = await getOAuthState(
        env.EMAIL_KV,
        config.statePrefix,
        state,
      );
      if (!accountIdStr) {
        return {
          ok: false,
          title: "state 无效",
          detail: "授权会话已过期或不匹配，请重新发起授权。",
          status: 400,
        };
      }

      const accountId = parseInt(accountIdStr, 10);
      if (Number.isNaN(accountId) || accountId <= 0) {
        return {
          ok: false,
          title: "参数无效",
          detail: "Invalid account ID in state.",
          status: 400,
        };
      }
      const account = await getAccountById(env.DB, accountId);
      let accountEmail = account?.email || "unknown";

      const { clientId, clientSecret } = config.getCredentials(env);
      // 当前请求就是 OAuth server 回调进来的 URL，redirect_uri 直接用它（去掉 query）
      const redirectUri = `${requestUrl.origin}${requestUrl.pathname}`;
      const tokenResp = await http.post(config.tokenUrl, {
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          ...config.extraTokenBody?.(env),
        }),
        throwHttpErrors: false,
      });

      const rawBody = await tokenResp.text();
      let tokenData: OAuthTokenResponse = {};
      try {
        tokenData = JSON.parse(rawBody) as OAuthTokenResponse;
      } catch {
        /* non-JSON response */
      }

      if (!tokenResp.ok) {
        // Token exchange failed — don't delete state so the user can retry
        return {
          ok: false,
          title: "Token 交换失败",
          detail: rawBody || `${tokenResp.status} ${tokenResp.statusText}`,
          status: tokenResp.status,
        };
      }

      // Token exchange succeeded — now safe to delete the one-time state
      await deleteOAuthState(env.EMAIL_KV, config.statePrefix, state);

      const refreshToken = tokenData.refresh_token;
      if (account) {
        const updates: Promise<void>[] = [];
        if (refreshToken) {
          updates.push(updateRefreshToken(env.DB, account.id, refreshToken));
        }
        if (tokenData.access_token) {
          try {
            const email = await config.fetchEmail(tokenData.access_token);
            if (email) {
              accountEmail = email;
              updates.push(updateAccountEmail(env.DB, account.id, email));
            }
          } catch {
            // 获取邮箱失败不影响主流程
          }
        }
        await Promise.all(updates);

        if (tokenData.access_token && tokenData.expires_in) {
          await putCachedAccessToken(
            env.EMAIL_KV,
            account.id,
            tokenData.access_token,
            Math.max(tokenData.expires_in - 120, 60),
          );
        }

        if (refreshToken || account.refresh_token) {
          try {
            const freshAccount = {
              ...account,
              refresh_token: (refreshToken || account.refresh_token) as string,
              email: accountEmail !== "unknown" ? accountEmail : account.email,
            };
            await config.onAuthorized(env, freshAccount);
          } catch (err) {
            await reportErrorToObservability(
              env,
              `oauth.${config.name.toLowerCase()}_auto_subscribe_failed`,
              err,
              {
                accountEmail,
              },
            );
          }
        }
      }

      return {
        ok: true,
        refreshToken,
        scope: tokenData.scope || config.scope,
        expiresIn: tokenData.expires_in,
        accountEmail,
        accountId,
        ownerTelegramId: account?.telegram_user_id ?? null,
      };
    }

    return {
      generateOAuthUrl,
      startOAuth,
      processOAuthCallback,
    };
  }
}

export type OAuthHandler = ReturnType<typeof EmailProvider.createOAuthHandler>;

/**
 * 具体 EmailProvider 子类的构造器类型。
 * 支持 OAuth 的子类要提供 static `oauth`（IMAP 没有）。
 */
export interface EmailProviderClass {
  new (account: Account, env: Env): EmailProvider;
  oauth?: OAuthHandler;
}
