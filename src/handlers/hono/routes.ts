// ── API routes (POST / webhooks) ─────────────────────────────────────────────
// Provider-specific push / bridge routes 定义在各自的 provider 文件里（见
// `providers/gmail/index.ts` 等）—— 外部（如 Pub/Sub、MS Graph、IMAP bridge）用的是硬编码 URL。
export const ROUTE_TELEGRAM_WEBHOOK = "/api/telegram/webhook";
export const ROUTE_PREVIEW_API = "/api/preview";
export const ROUTE_CORS_PROXY = "/api/cors-proxy";

// ── Auth routes ──────────────────────────────────────────────────────────────
export const ROUTE_LOGIN = "/login";
export const ROUTE_LOGIN_CALLBACK = "/login/callback";

// ── Path param names ─────────────────────────────────────────────────────────
export const PARAM_PROVIDER = "provider";

// ── Page routes (GET / HTML) ─────────────────────────────────────────────────
// OAuth 路由按 AccountType 聚合：/oauth/gmail/*, /oauth/outlook/*, ...
export const ROUTE_OAUTH_SETUP = `/oauth/:${PARAM_PROVIDER}`;
export const ROUTE_OAUTH_START = `/oauth/:${PARAM_PROVIDER}/start`;
export const ROUTE_OAUTH_CALLBACK = `/oauth/:${PARAM_PROVIDER}/callback`;

export const ROUTE_PREVIEW = "/preview";
export const ROUTE_MAIL = "/mail/:id";
export const ROUTE_JUNK_CHECK = "/junk-check";
export const ROUTE_JUNK_CHECK_API = "/api/junk-check";
export const ROUTE_MAIL_MOVE_TO_INBOX = "/api/mail/:id/move-to-inbox";
export const ROUTE_MAIL_MARK_JUNK = "/api/mail/:id/mark-as-junk";
export const ROUTE_MAIL_TRASH = "/api/mail/:id/trash";
export const ROUTE_MAIL_TOGGLE_STAR = "/api/mail/:id/toggle-star";
export const ROUTE_MAIL_ARCHIVE = "/api/mail/:id/archive";
export const ROUTE_MAIL_UNARCHIVE = "/api/mail/:id/unarchive";

// ── Mini App ─────────────────────────────────────────────────────────────────
// `/telegram-app` 是 BotFather `/newapp` 注册的入口（Web App URL）。
// 进来后 JS 根据 start_param 前缀重定向到具体子页面。私聊场景的 web_app 按钮
// 直接跳子页面 URL，绕过 router。
//
// 子页面：
//   /telegram-app/reminders?accountId=&emailMessageId=&token= → 设提醒
//   /telegram-app/mail/:id?accountId=&t=                      → 邮件预览（含 FAB 操作）
//
// start_param 格式（群聊 deep link 用）：
//   r_<chatId>_<tgMsgId>  → 提醒（可省略 r_ 前缀，向后兼容旧按钮）
//   m_<chatId>_<tgMsgId>  → 邮件
export const ROUTE_MINI_APP = "/telegram-app";
export const ROUTE_MINI_APP_REMINDERS = "/telegram-app/reminders";
export const ROUTE_MINI_APP_MAIL = "/telegram-app/mail/:id";
export const ROUTE_MINI_APP_LIST = "/telegram-app/list/:type";

// API
export const ROUTE_MINI_APP_API_LIST = "/api/mini-app/list/:type";
export const ROUTE_MINI_APP_API_MARK_ALL_READ =
  "/api/mini-app/mark-all-as-read";
export const ROUTE_MINI_APP_API_TRASH_ALL_JUNK = "/api/mini-app/trash-all-junk";
// API 路径继续按功能命名（reminder API 不会被复用到其他功能）
export const ROUTE_REMINDERS_API = "/api/reminders";
export const ROUTE_REMINDERS_API_ITEM = "/api/reminders/:id";
export const ROUTE_REMINDERS_API_EMAIL_CONTEXT = "/api/reminders/email-context";
export const ROUTE_REMINDERS_API_RESOLVE_CONTEXT =
  "/api/reminders/resolve-context";
