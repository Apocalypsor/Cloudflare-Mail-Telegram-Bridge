// ── API routes (POST / webhooks) ─────────────────────────────────────────────
// Provider-specific push / bridge routes 定义在各自的 provider 文件里（见
// `providers/gmail/index.ts` 等）—— 外部（如 Pub/Sub、MS Graph、IMAP bridge）用的是硬编码 URL。
export const ROUTE_TELEGRAM_WEBHOOK = "/api/telegram/webhook";
export const ROUTE_PREVIEW_API = "/api/preview";
export const ROUTE_CORS_PROXY = "/api/cors-proxy";

// ── Auth routes ──────────────────────────────────────────────────────────────
// `/login` 页面本身由 Pages 提供（page/src/routes/login.tsx），TG Login
// Widget 把 auth 数据 POST/GET 到 callback（Worker 端），验签 + 写 D1 + 下
// session cookie。callback 放在 `/api/*` 下以便 Workers Routes 一条
// `/api/*` 规则就能命中，不需要单独给 `/login/callback` 开路由。
export const ROUTE_LOGIN = "/login";
export const ROUTE_LOGIN_CALLBACK = "/api/login/callback";
// 登录页挂载时拉一下 bot username（TG Login Widget 需要 data-telegram-login
// 属性），不敏感，不要鉴权。
export const ROUTE_PUBLIC_BOT_INFO = "/api/public/bot-info";
// Session status probe —— 非 Mini App 的 web 页（/preview, /junk-check）在挂载
// 时调这个检查登录；200 = 已登录 + approved，401 = 跳登录页。
export const ROUTE_SESSION_WHOAMI = "/api/session/whoami";
// POST 清 session cookie 登出 —— web 页 header 里的下拉菜单调这个。
export const ROUTE_SESSION_LOGOUT = "/api/session/logout";

// ── Path param names ─────────────────────────────────────────────────────────
export const PARAM_PROVIDER = "provider";

// ── Page routes (GET / HTML) ─────────────────────────────────────────────────
// OAuth 路由按 AccountType 聚合：/oauth/gmail/*, /oauth/outlook/*, ...
export const ROUTE_OAUTH_SETUP = `/oauth/:${PARAM_PROVIDER}`;
export const ROUTE_OAUTH_START = `/oauth/:${PARAM_PROVIDER}/start`;
export const ROUTE_OAUTH_CALLBACK = `/oauth/:${PARAM_PROVIDER}/callback`;

// Page routes for /preview /junk-check /mail/:id 已搬到 Pages（page/src/paths.ts），
// 这里只保留 API endpoints。
export const ROUTE_JUNK_CHECK_API = "/api/junk-check";
// GET mail preview JSON —— token-only auth，Web 和 Mini App 共用
export const ROUTE_MAIL_API = "/api/mail/:id";
export const ROUTE_MAIL_MOVE_TO_INBOX = "/api/mail/:id/move-to-inbox";
export const ROUTE_MAIL_MARK_JUNK = "/api/mail/:id/mark-as-junk";
export const ROUTE_MAIL_TRASH = "/api/mail/:id/trash";
export const ROUTE_MAIL_TOGGLE_STAR = "/api/mail/:id/toggle-star";
export const ROUTE_MAIL_ARCHIVE = "/api/mail/:id/archive";
export const ROUTE_MAIL_UNARCHIVE = "/api/mail/:id/unarchive";

// ── Mini App ─────────────────────────────────────────────────────────────────
// UI 页面路径（/telegram-app/*）属于 page，定义在 page/src/paths.ts。
// 本文件只管 Worker 自己定义的 API endpoints。
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
