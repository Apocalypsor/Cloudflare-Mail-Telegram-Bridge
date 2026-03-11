// ── Google / Gmail ────────────────────────────────────────────────────────────
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

// ── KV keys & prefixes ──────────────────────────────────────────────────────
export const KV_PROCESSED_PREFIX = 'processed_message:';
export const KV_OAUTH_STATE_PREFIX = 'oauth_state:';
export const KV_BOT_INFO_KEY = 'telegram:bot_info';

// ── TTL (seconds) ────────────────────────────────────────────────────────────
export const PROCESSED_TTL_SECONDS = 60 * 60 * 24; // 1 天
export const MAIL_HTML_CACHE_TTL = 60 * 60 * 24 * 7; // 7 天
export const OAUTH_STATE_TTL_SECONDS = 10 * 60; // 10 分钟

export const BOT_INFO_TTL = 86400 * 30; // 30 天

// ── Telegram limits ──────────────────────────────────────────────────────────
export const TG_MSG_LIMIT = 4096;
export const TG_CAPTION_LIMIT = 1024;
export const TG_MEDIA_GROUP_LIMIT = 10;
export const TG_MAX_RETRY_AFTER_SECS = 60;

// ── LLM / 邮件处理 ──────────────────────────────────────────────────────────
export const MAX_BODY_CHARS = 4000;
export const MAX_LINKS = 20;

// ── IMAP flags ───────────────────────────────────────────────────────────────
export const IMAP_FLAG_SEEN = '\\Seen' as const;
export const IMAP_FLAG_FLAGGED = '\\Flagged' as const;

// ── Display ──────────────────────────────────────────────────────────────────
export const MESSAGE_DATE_LOCALE = 'zh-CN';
export const MESSAGE_DATE_TIMEZONE = 'America/New_York';
