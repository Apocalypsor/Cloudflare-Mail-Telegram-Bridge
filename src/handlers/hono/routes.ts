// ── API routes (POST / webhooks) ─────────────────────────────────────────────
export const ROUTE_TELEGRAM_WEBHOOK = '/api/telegram/webhook';
export const ROUTE_GMAIL_PUSH = '/api/gmail/push';
export const ROUTE_PREVIEW_API = '/api/preview';
export const ROUTE_CORS_PROXY = '/api/cors-proxy';

// ── IMAP bridge routes ────────────────────────────────────────────────────────
export const ROUTE_IMAP_ACCOUNTS = '/api/imap/accounts';
export const ROUTE_IMAP_PUSH = '/api/imap/push';

// ── Outlook / Microsoft Graph routes ─────────────────────────────────────────
export const ROUTE_OUTLOOK_PUSH = '/api/outlook/push';

// ── Auth routes ──────────────────────────────────────────────────────────────
export const ROUTE_LOGIN = '/login';
export const ROUTE_LOGIN_CALLBACK = '/login/callback';

// ── Page routes (GET / HTML) ─────────────────────────────────────────────────
export const ROUTE_OAUTH_GOOGLE = '/oauth/google';
export const ROUTE_OAUTH_GOOGLE_START = '/oauth/google/start';
export const ROUTE_OAUTH_GOOGLE_CALLBACK = '/oauth/google/callback';
export const ROUTE_OAUTH_MICROSOFT = '/oauth/microsoft';
export const ROUTE_OAUTH_MICROSOFT_START = '/oauth/microsoft/start';
export const ROUTE_OAUTH_MICROSOFT_CALLBACK = '/oauth/microsoft/callback';
export const ROUTE_PREVIEW = '/preview';
export const ROUTE_MAIL = '/mail/:id';
export const ROUTE_JUNK_CHECK = '/junk-check';
export const ROUTE_JUNK_CHECK_API = '/api/junk-check';
