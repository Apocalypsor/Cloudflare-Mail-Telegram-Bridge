import type { MailMeta } from "@/types";

// ─── KV keys & prefixes ──────────────────────────────────────────────��─────

const KV_OAUTH_STATE_PREFIX = "oauth_state:";
const KV_OAUTH_BOT_MSG_PREFIX = "oauth_bot_msg:";
const KV_MS_SUB_ACCOUNT_PREFIX = "ms_sub_account:";
const KV_MS_SUBSCRIPTION_PREFIX = "ms_subscription:";
const KV_BOT_INFO_KEY = "telegram:bot_info";
const KV_BOT_COMMANDS_VERSION_KEY = "telegram:bot_commands_version";

// ─── TTLs ───────────────────────────────────────────────────────────────────

const MAIL_HTML_CACHE_TTL = 60 * 60 * 24 * 7; // 7 天
const OAUTH_STATE_TTL_SECONDS = 10 * 60; // 10 分钟
const BOT_INFO_TTL = 86400 * 30; // 30 天

// ─── Access Token Cache ─────────────────────────────────────────────────────

function kvAccessTokenKey(accountId: number): string {
  return `access_token:${accountId}`;
}

export async function getCachedAccessToken(
  kv: KVNamespace,
  accountId: number,
): Promise<string | null> {
  return kv.get(kvAccessTokenKey(accountId));
}

export async function putCachedAccessToken(
  kv: KVNamespace,
  accountId: number,
  token: string,
  ttlSeconds: number,
): Promise<void> {
  await kv.put(kvAccessTokenKey(accountId), token, {
    expirationTtl: ttlSeconds,
  });
}

export async function deleteCachedAccessToken(
  kv: KVNamespace,
  accountId: number,
): Promise<void> {
  await kv.delete(kvAccessTokenKey(accountId));
}

// ─── Mail HTML Cache ────────────────────────────────────────────────────────

// IMAP 的 messageId 是 per-folder UID，必须带 accountId + folder 否则不同文件夹
// 的同号 UID 会错误命中同一条缓存
function kvMailHtmlKey(
  accountId: number,
  folder: string,
  messageId: string,
): string {
  return `mail_html:${accountId}:${folder}:${messageId}`;
}

interface CachedMailData {
  html: string;
  meta?: MailMeta;
}

export async function getCachedMailData(
  kv: KVNamespace,
  accountId: number,
  folder: string,
  messageId: string,
): Promise<CachedMailData | null> {
  const raw = await kv.get(kvMailHtmlKey(accountId, folder, messageId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedMailData;
  } catch {
    // 兼容旧格式（纯 HTML 字符串）
    return { html: raw };
  }
}

export async function putCachedMailData(
  kv: KVNamespace,
  accountId: number,
  folder: string,
  messageId: string,
  data: CachedMailData,
): Promise<void> {
  await kv.put(
    kvMailHtmlKey(accountId, folder, messageId),
    JSON.stringify(data),
    { expirationTtl: MAIL_HTML_CACHE_TTL },
  );
}

// ─── OAuth State ────────────────────────────────────────────────────────────

export async function putOAuthState(
  kv: KVNamespace,
  statePrefix: string,
  state: string,
  accountId: number,
): Promise<void> {
  await kv.put(
    `${KV_OAUTH_STATE_PREFIX}${statePrefix}${state}`,
    String(accountId),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS },
  );
}

export async function getOAuthState(
  kv: KVNamespace,
  statePrefix: string,
  state: string,
): Promise<string | null> {
  return kv.get(`${KV_OAUTH_STATE_PREFIX}${statePrefix}${state}`);
}

export async function deleteOAuthState(
  kv: KVNamespace,
  statePrefix: string,
  state: string,
): Promise<void> {
  await kv.delete(`${KV_OAUTH_STATE_PREFIX}${statePrefix}${state}`);
}

// ─── OAuth Bot Message (回写 Bot 消息位置) ──────────────────────────────────

interface OAuthBotMsg {
  chatId: string;
  messageId: number;
}

export async function putOAuthBotMsg(
  kv: KVNamespace,
  accountId: number,
  msg: OAuthBotMsg,
): Promise<void> {
  await kv.put(`${KV_OAUTH_BOT_MSG_PREFIX}${accountId}`, JSON.stringify(msg), {
    expirationTtl: OAUTH_STATE_TTL_SECONDS,
  });
}

export async function getOAuthBotMsg(
  kv: KVNamespace,
  accountId: number,
): Promise<OAuthBotMsg | null> {
  const raw = await kv.get(`${KV_OAUTH_BOT_MSG_PREFIX}${accountId}`);
  if (!raw) return null;
  return JSON.parse(raw) as OAuthBotMsg;
}

export async function deleteOAuthBotMsg(
  kv: KVNamespace,
  accountId: number,
): Promise<void> {
  await kv.delete(`${KV_OAUTH_BOT_MSG_PREFIX}${accountId}`);
}

// ─── Outlook Subscription ─────────────────────────────────────────────��─────

export async function getMsSubscriptionId(
  kv: KVNamespace,
  accountId: number,
): Promise<string | null> {
  return kv.get(`${KV_MS_SUBSCRIPTION_PREFIX}${accountId}`);
}

export async function putMsSubscription(
  kv: KVNamespace,
  accountId: number,
  subscriptionId: string,
  ttlSeconds: number,
): Promise<void> {
  await Promise.all([
    kv.put(`${KV_MS_SUBSCRIPTION_PREFIX}${accountId}`, subscriptionId, {
      expirationTtl: ttlSeconds,
    }),
    kv.put(`${KV_MS_SUB_ACCOUNT_PREFIX}${subscriptionId}`, String(accountId), {
      expirationTtl: ttlSeconds,
    }),
  ]);
}

export async function refreshMsSubAccountMapping(
  kv: KVNamespace,
  subscriptionId: string,
  accountId: number,
  ttlSeconds: number,
): Promise<void> {
  await kv.put(
    `${KV_MS_SUB_ACCOUNT_PREFIX}${subscriptionId}`,
    String(accountId),
    { expirationTtl: ttlSeconds },
  );
}

export async function getMsAccountBySubscription(
  kv: KVNamespace,
  subscriptionId: string,
): Promise<string | null> {
  return kv.get(`${KV_MS_SUB_ACCOUNT_PREFIX}${subscriptionId}`);
}

export async function deleteMsSubscription(
  kv: KVNamespace,
  accountId: number,
): Promise<void> {
  const subId = await getMsSubscriptionId(kv, accountId);
  await kv.delete(`${KV_MS_SUBSCRIPTION_PREFIX}${accountId}`);
  if (subId) {
    await kv.delete(`${KV_MS_SUB_ACCOUNT_PREFIX}${subId}`);
  }
}

// ─── Bot Info Cache ─────────────────────────────────────────────────────────

export async function getCachedBotInfo(
  kv: KVNamespace,
): Promise<string | null> {
  return kv.get(KV_BOT_INFO_KEY);
}

export async function putCachedBotInfo(
  kv: KVNamespace,
  botInfo: string,
): Promise<void> {
  await kv.put(KV_BOT_INFO_KEY, botInfo, {
    expirationTtl: BOT_INFO_TTL,
  });
}

// ─── Bot Commands Version ───────────────────────────────────────────────────

export async function getBotCommandsVersion(
  kv: KVNamespace,
): Promise<string | null> {
  return kv.get(KV_BOT_COMMANDS_VERSION_KEY);
}

export async function putBotCommandsVersion(
  kv: KVNamespace,
  version: string,
): Promise<void> {
  await kv.put(KV_BOT_COMMANDS_VERSION_KEY, version);
}
