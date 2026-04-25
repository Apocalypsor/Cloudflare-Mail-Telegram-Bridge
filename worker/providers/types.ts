/** Provider 层对外公开的类型定义（接口 / 纯数据形状） */

import type { EmailProvider } from "@providers/base";
import type { Hono } from "hono";
import type { Account, AppEnv, Env, MailMeta } from "@/types";

/** 列表类 API 返回的最简邮件条目 */
export interface EmailListItem {
  id: string;
  subject?: string;
  /** 发件人，已格式化为 `Name <addr>` 或裸 addr。仅 search 类列表填充。 */
  from?: string;
}

/** 邮件当前所在位置 —— 对账时用这个值决定 TG 侧如何处理 */
export type MessageLocation = "inbox" | "junk" | "archive" | "deleted";

/** `resolveMessageState` 返回：位置 + （inbox 时的）星标状态 */
export type MessageState =
  | { location: "inbox"; starred: boolean }
  | { location: "junk" | "archive" | "deleted" };

/** 邮件 web 预览用的渲染内容 */
export interface PreviewContent {
  html: string;
  cidMap: Map<string, string>;
  meta: MailMeta;
}

/** OAuth token 接口的响应体（Google / Microsoft 同构） */
export interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** `processOAuthCallback` 的结果：成功包含 refresh_token 等；失败带错误信息 + HTTP status */
export type OAuthCallbackResult =
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

/** 传给 `EmailProvider.createOAuthHandler` 的 provider 特定配置 */
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

/** `createOAuthHandler` 的返回形状 —— OAuth 流程对外暴露的几个操作 */
export interface OAuthHandler {
  /** OAuth 提供方的展示名（"Google" / "Microsoft"），用于 bot UI */
  name: string;
  /** 当前 env 是否已配置该 provider 的 clientId / clientSecret */
  isConfigured(env: Env): boolean;
  generateOAuthUrl(
    env: Env,
    accountId: number,
    callbackUrl: string,
  ): Promise<string>;
  startOAuth(request: Request, env: Env, accountId: number): Promise<Response>;
  processOAuthCallback(
    request: Request,
    env: Env,
  ): Promise<OAuthCallbackResult>;
}

/**
 * 具体 EmailProvider 子类的构造器类型（加上 static 元数据 / 能力位）。
 * 支持 OAuth 的子类要提供 static `oauth`（IMAP 为 undefined）。
 */
export interface EmailProviderClass {
  new (account: Account, env: Env): EmailProvider;
  /** UI 展示名，e.g. "Gmail" / "Outlook" / "IMAP" */
  displayName: string;
  /** OAuth 流程处理器（IMAP 为 undefined） */
  oauth?: OAuthHandler;
  /** 当前 account 是否可执行归档 */
  canArchive(account: Account): boolean;
  /** 账号详情页是否显示"归档标签"入口（Gmail 需要，其他自动） */
  needsArchiveSetup: boolean;
  /**
   * 注册 provider 自己需要的 HTTP 路由（push webhook、bridge 用的 accounts 列表等）。
   * 由 `handlers/hono/push.ts` 遍历 PROVIDERS 调用；没有 HTTP 面的 provider 可以不实现。
   */
  registerRoutes?(app: Hono<AppEnv>): void;
}
