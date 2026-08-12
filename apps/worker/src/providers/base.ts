import { http } from "@worker/clients/http";
import {
  getAccountById,
  updateAccountEmail,
  updateRefreshToken,
} from "@worker/db/accounts";
import {
  deleteOAuthState,
  getOAuthState,
  putCachedAccessToken,
  putOAuthState,
} from "@worker/db/kv";
import { EmailMessageNotFoundError } from "@worker/errors/email-provider";
import type {
  EmailCount,
  EmailListItem,
  EmailListPage,
  MessageState,
  OAuthCallbackResult,
  OAuthHandler,
  OAuthProviderConfig,
  OAuthTokenResponse,
  PreviewContent,
  RawEmailWithState,
} from "@worker/providers/types";
import { attachmentBody, parseOffsetCursor } from "@worker/providers/utils";
import type {
  Account,
  Env,
  MailAttachmentDownload,
  WaitUntil,
} from "@worker/types";
import {
  formatAddress,
  parseEmailDate,
  wrapPlainText,
} from "@worker/utils/mail/body";
import {
  buildAttachmentMetaFromMime,
  buildCidMapFromAttachments,
  visibleMailAttachments,
} from "@worker/utils/mail/mime";
import { reportErrorToObservability } from "@worker/utils/observability";
import { HTTPError } from "ky";
import PostalMime from "postal-mime";

export abstract class EmailProvider {
  private static readonly DEFAULT_COUNT_LIMIT = 1000;
  private static readonly COUNT_PAGE_SIZE = 100;

  protected account: Account;
  protected env: Env;
  private accessTokenPromise?: Promise<string>;

  constructor(account: Account, env: Env) {
    this.account = account;
    this.env = env;
  }

  abstract markAsRead(
    messageId: string,
    folder?: "inbox" | "junk" | "archive",
  ): Promise<void>;

  abstract addStar(
    messageId: string,
    folder?: "inbox" | "junk" | "archive",
  ): Promise<void>;

  abstract removeStar(
    messageId: string,
    folder?: "inbox" | "junk" | "archive",
  ): Promise<void>;

  abstract isStarred(
    messageId: string,
    folder?: "inbox" | "junk" | "archive",
  ): Promise<boolean>;

  abstract resolveMessageState(messageId: string): Promise<MessageState>;

  abstract listUnread(maxResults?: number): Promise<EmailListItem[]>;

  abstract listStarred(maxResults?: number): Promise<EmailListItem[]>;

  abstract listJunk(maxResults?: number): Promise<EmailListItem[]>;

  abstract listArchived(maxResults?: number): Promise<EmailListItem[]>;

  abstract searchMessages(
    query: string,
    maxResults?: number,
  ): Promise<EmailListItem[]>;

  async countUnread(maxCount?: number): Promise<EmailCount> {
    return this.countByPage(
      (limit, cursor) => this.listUnreadPage(limit, cursor),
      maxCount,
    );
  }

  async countJunk(maxCount?: number): Promise<EmailCount> {
    return this.countByPage(
      (limit, cursor) => this.listJunkPage(limit, cursor),
      maxCount,
    );
  }

  async listUnreadPage(
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return this.pageByOffset(
      (limit) => this.listUnread(limit),
      maxResults,
      cursor,
    );
  }

  async listStarredPage(
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return this.pageByOffset(
      (limit) => this.listStarred(limit),
      maxResults,
      cursor,
    );
  }

  async listJunkPage(
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return this.pageByOffset(
      (limit) => this.listJunk(limit),
      maxResults,
      cursor,
    );
  }

  async listArchivedPage(
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return this.pageByOffset(
      (limit) => this.listArchived(limit),
      maxResults,
      cursor,
    );
  }

  async searchMessagesPage(
    query: string,
    maxResults: number = 20,
    cursor?: string,
  ): Promise<EmailListPage> {
    return this.pageByOffset(
      (limit) => this.searchMessages(query, limit),
      maxResults,
      cursor,
    );
  }

  private async countByPage(
    fetchPage: (maxResults: number, cursor?: string) => Promise<EmailListPage>,
    maxCount: number | undefined,
  ): Promise<EmailCount> {
    const limit = this.normalizeCountLimit(maxCount);
    let count = 0;
    let cursor: string | undefined;

    while (count < limit) {
      const pageSize = Math.min(EmailProvider.COUNT_PAGE_SIZE, limit - count);
      const page = await fetchPage(pageSize, cursor);
      count += page.items.length;

      if (!page.nextCursor) return { count, truncated: false };
      if (page.items.length === 0) return { count, truncated: true };
      cursor = page.nextCursor;
    }

    return { count, truncated: !!cursor };
  }

  protected normalizeCountLimit(maxCount: number | undefined): number {
    return Math.max(
      1,
      Math.trunc(maxCount ?? EmailProvider.DEFAULT_COUNT_LIMIT),
    );
  }

  protected memoizeAccessToken(
    fetchToken: () => Promise<string>,
  ): Promise<string> {
    this.accessTokenPromise ??= fetchToken().catch((err) => {
      this.accessTokenPromise = undefined;
      throw err;
    });
    return this.accessTokenPromise;
  }

  abstract markAsJunk(messageId: string): Promise<void>;

  abstract markAllAsRead(
    maxResults?: number,
  ): Promise<{ success: number; failed: number }>;

  /** 返回新 messageId —— Gmail 不变；Outlook / IMAP 因 folder 切换会换 id。 */
  abstract moveToInbox(messageId: string): Promise<string>;

  abstract unarchiveMessage(messageId: string): Promise<string>;

  abstract trashMessage(messageId: string): Promise<void>;

  abstract trashAllJunk(): Promise<number>;

  /** 调用前先 `PROVIDERS[account.type].canArchive(account)` —— Gmail 没配 archive_folder 会失败。 */
  abstract archiveMessage(messageId: string): Promise<void>;

  abstract fetchRawEmail(
    messageId: string,
    folder?: "inbox" | "junk" | "archive",
  ): Promise<ArrayBuffer>;

  async fetchRawEmailWithState(messageId: string): Promise<RawEmailWithState> {
    let rawEmail: ArrayBuffer;
    try {
      rawEmail = await this.fetchRawEmail(messageId);
    } catch (error) {
      if (error instanceof HTTPError && error.response.status === 404) {
        throw new EmailMessageNotFoundError(messageId, "INBOX", error);
      }
      throw error;
    }
    const state = await this.resolveMessageState(messageId).catch(() => null);
    return { rawEmail, state };
  }

  private async pageByOffset(
    fetcher: (maxResults: number) => Promise<EmailListItem[]>,
    maxResults: number,
    cursor: string | undefined,
  ): Promise<EmailListPage> {
    const offset = parseOffsetCursor(cursor);
    const items = await fetcher(offset + maxResults + 1);
    return {
      items: items.slice(offset, offset + maxResults),
      nextCursor:
        items.length > offset + maxResults ? String(offset + maxResults) : null,
    };
  }

  async fetchForPreview(
    messageId: string,
    folder: "inbox" | "junk" | "archive",
  ): Promise<PreviewContent | null> {
    const rawEmail = await this.fetchRawEmail(messageId, folder);
    const email = await new PostalMime().parse(rawEmail);
    const html = email.html ?? (email.text ? wrapPlainText(email.text) : null);
    if (!html) return null;
    return {
      html,
      cidMap: buildCidMapFromAttachments(email.attachments),
      attachments: buildAttachmentMetaFromMime(email.attachments),
      meta: {
        subject: email.subject ?? null,
        from: email.from ? formatAddress(email.from) : null,
        to: email.to?.map(formatAddress).join(", ") ?? null,
        date: parseEmailDate(email.date),
      },
    };
  }

  async fetchAttachment(
    messageId: string,
    attachmentId: string,
    folder: "inbox" | "junk" | "archive",
  ): Promise<MailAttachmentDownload | null> {
    const index = Number(attachmentId);
    if (!Number.isInteger(index) || index < 0) return null;
    const rawEmail = await this.fetchRawEmail(messageId, folder);
    const email = await new PostalMime().parse(rawEmail);
    const att = visibleMailAttachments(email.attachments)[index];
    if (!att) return null;
    return {
      filename: att.filename || null,
      mimeType: att.mimeType || null,
      body: attachmentBody(att.content),
    };
  }

  async renewPush(): Promise<void> {}

  async stopPush(): Promise<void> {}

  /** 账号持久化状态变化后的钩子；默认 no-op。 */
  async onPersistedChange(): Promise<void> {}

  /** 默认 true；Gmail override 检查 archive_folder。 */
  static canArchive(_account: Account): boolean {
    return true;
  }

  /** 账号详情页是否显示归档标签入口。目前只有 Gmail（label 方式）需要。 */
  static needsArchiveSetup = false;

  /** 子类必须 override —— 解析 provider 推送 payload 并安排后台投递。 */
  static async dispatch(
    _body: unknown,
    _env: Env,
    _waitUntil: WaitUntil,
  ): Promise<void> {
    throw new Error("dispatch not implemented");
  }

  static createOAuthHandler(config: OAuthProviderConfig): OAuthHandler {
    const generateOAuthUrl = async (
      env: Env,
      accountId: number,
      callbackUrl: string,
    ): Promise<string> => {
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
    };

    const startOAuth = async (
      request: Request,
      env: Env,
      accountId: number,
    ): Promise<Response> => {
      // start 路由命中 /oauth/:provider/start，callback 就是把 /start 换成 /callback
      const url = new URL(request.url);
      const callbackUrl = `${url.origin}${url.pathname.replace(/\/start$/, "/callback")}`;
      const authorizeUrl = await generateOAuthUrl(env, accountId, callbackUrl);
      return Response.redirect(authorizeUrl, 302);
    };

    const processOAuthCallback = async (
      request: Request,
      env: Env,
    ): Promise<OAuthCallbackResult> => {
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
    };

    return {
      name: config.name,
      isConfigured: (env: Env) => {
        const { clientId, clientSecret } = config.getCredentials(env);
        return !!clientId && !!clientSecret;
      },
      generateOAuthUrl,
      startOAuth,
      processOAuthCallback,
    };
  }
}
