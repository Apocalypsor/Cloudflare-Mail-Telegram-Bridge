// ── API routes (POST / webhooks) ─────────────────────────────────────────────
export const ROUTE_TELEGRAM_WEBHOOK = "/api/telegram/webhook";
export const ROUTE_GMAIL_PUSH = "/api/gmail/push";
export const ROUTE_PREVIEW_API = "/api/preview";
export const ROUTE_CORS_PROXY = "/api/cors-proxy";

// ── IMAP bridge routes ────────────────────────────────────────────────────────
export const ROUTE_IMAP_ACCOUNTS = "/api/imap/accounts";
export const ROUTE_IMAP_PUSH = "/api/imap/push";

// ── Outlook / Microsoft Graph routes ─────────────────────────────────────────
export const ROUTE_OUTLOOK_PUSH = "/api/outlook/push";

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
