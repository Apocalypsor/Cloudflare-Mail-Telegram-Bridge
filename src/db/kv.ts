import { MAIL_HTML_CACHE_TTL } from "@/constants";
import type { Env, MailMeta } from "@/types";

// ─── Key helpers ────────────────────────────────────────────────────────────

function kvAccessTokenKey(accountId: number): string {
  return `access_token:${accountId}`;
}

// ─── Access Token Cache ─────────────────────────────────────────────────────

export async function getCachedAccessToken(
  env: Env,
  accountId: number,
): Promise<string | null> {
  return env.EMAIL_KV.get(kvAccessTokenKey(accountId));
}

export async function putCachedAccessToken(
  env: Env,
  accountId: number,
  token: string,
  ttlSeconds: number,
): Promise<void> {
  await env.EMAIL_KV.put(kvAccessTokenKey(accountId), token, {
    expirationTtl: ttlSeconds,
  });
}

export async function deleteCachedAccessToken(
  env: Env,
  accountId: number,
): Promise<void> {
  await env.EMAIL_KV.delete(kvAccessTokenKey(accountId));
}

// ─── Mail HTML Cache ────────────────────────────────────────────────────────

function kvMailHtmlKey(gmailMessageId: string): string {
  return `mail_html:${gmailMessageId}`;
}

export interface CachedMailData {
  html: string;
  meta?: MailMeta;
}

export async function getCachedMailData(
  env: Env,
  messageId: string,
): Promise<CachedMailData | null> {
  const raw = await env.EMAIL_KV.get(kvMailHtmlKey(messageId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedMailData;
  } catch {
    // 兼容旧格式（纯 HTML 字符串）
    return { html: raw };
  }
}

export async function putCachedMailData(
  env: Env,
  messageId: string,
  data: CachedMailData,
): Promise<void> {
  await env.EMAIL_KV.put(kvMailHtmlKey(messageId), JSON.stringify(data), {
    expirationTtl: MAIL_HTML_CACHE_TTL,
  });
}
