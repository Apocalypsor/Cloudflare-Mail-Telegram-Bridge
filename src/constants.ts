// ── Google / Gmail ────────────────────────────────────────────────────────────
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

// ── Microsoft / Outlook ─────────────────────────────────────────────────────
export const MS_OAUTH_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const MS_OAUTH_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const MS_GRAPH_API = 'https://graph.microsoft.com/v1.0';
export const MS_MAIL_SCOPE = 'offline_access Mail.ReadWrite User.Read';
/** Graph webhook subscription max lifetime for mail: ~4230 min ≈ 2.9 days; we use 2 days */
export const MS_SUBSCRIPTION_LIFETIME_MINUTES = 2 * 24 * 60;

// ── KV keys & prefixes ──────────────────────────────────────────────────────
export const KV_OAUTH_STATE_PREFIX = 'oauth_state:';
export const KV_OAUTH_BOT_MSG_PREFIX = 'oauth_bot_msg:';
export const KV_MS_SUB_ACCOUNT_PREFIX = 'ms_sub_account:';
export const KV_MS_SUBSCRIPTION_PREFIX = 'ms_subscription:';
export const KV_BOT_INFO_KEY = 'telegram:bot_info';
export const KV_BOT_COMMANDS_VERSION_KEY = 'telegram:bot_commands_version';

// ── Telegram API ────────────────────────────────────────────────────────────
export const TG_API_BASE = 'https://api.telegram.org/bot';

// ── TTL (seconds) ────────────────────────────────────────────────────────────
export const MAIL_HTML_CACHE_TTL = 60 * 60 * 24 * 7; // 7 天
export const OAUTH_STATE_TTL_SECONDS = 10 * 60; // 10 分钟

export const BOT_INFO_TTL = 86400 * 30; // 30 天

// ── Telegram limits ──────────────────────────────────────────────────────────
export const TG_MSG_LIMIT = 4096;
export const TG_CAPTION_LIMIT = 1024;
export const TG_MEDIA_GROUP_LIMIT = 10;

// ── LLM / 邮件处理 ──────────────────────────────────────────────────────────
export const MAX_BODY_CHARS = 4000;
export const MAX_LINKS = 20;

// ── IMAP flags ───────────────────────────────────────────────────────────────
export const IMAP_FLAG_SEEN = '\\Seen' as const;
export const IMAP_FLAG_FLAGGED = '\\Flagged' as const;

// ── Tags ─────────────────────────────────────────────────────────────────────
export const STAR_TAG = ' #星标';

// ── Session / Auth ──────────────────────────────────────────────────────────
export const TG_AUTH_MAX_AGE = 86400; // Telegram Login Widget auth_date 有效期（秒）
export const SESSION_TTL = 7 * 24 * 3600; // session cookie 有效期 7 天
export const SESSION_COOKIE_NAME = 'tg_session';
export const LLM_TIMEOUT_MS = 30_000; // LLM 请求超时（毫秒）

// ── Display ──────────────────────────────────────────────────────────────────
export const MESSAGE_DATE_LOCALE = 'zh-CN';
export const MESSAGE_DATE_TIMEZONE = 'America/New_York';
