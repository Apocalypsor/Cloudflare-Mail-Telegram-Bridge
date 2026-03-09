// ── API routes (POST / webhooks) ─────────────────────────────────────────────
export const ROUTE_TELEGRAM_WEBHOOK = '/api/telegram/webhook';
export const ROUTE_GMAIL_PUSH = '/api/gmail/push';
export const ROUTE_GMAIL_WATCH = '/api/gmail/watch';
export const ROUTE_ACCOUNTS = '/api/accounts';
export const ROUTE_ACCOUNTS_EDIT = '/api/accounts/:id/edit';
export const ROUTE_ACCOUNTS_DELETE = '/api/accounts/:id/delete';
export const ROUTE_ACCOUNTS_CLEAR_CACHE = '/api/accounts/:id/clear-cache';
export const ROUTE_ACCOUNTS_WATCH = '/api/accounts/:id/watch';
export const ROUTE_CLEAR_ALL_KV = '/api/clear-all-kv';
export const ROUTE_PREVIEW_API = '/api/preview';

// ── Page routes (GET / HTML) ─────────────────────────────────────────────────
export const ROUTE_OAUTH_GOOGLE = '/oauth/google';
export const ROUTE_OAUTH_GOOGLE_START = '/oauth/google/start';
export const ROUTE_OAUTH_GOOGLE_CALLBACK = '/oauth/google/callback';
export const ROUTE_PREVIEW = '/preview';
export const ROUTE_MAIL = '/mail/:id';
