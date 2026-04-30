import { SESSION_TTL, TG_AUTH_MAX_AGE } from "@worker/constants";
import { hmacSha256Hex, timingSafeEqual } from "@worker/utils/hash";

// ── Telegram Login Widget ───────────────────────────────────────────────────

export interface TelegramLoginData {
  id: string;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
}

/** 验证 Telegram Login Widget 数据（https://core.telegram.org/widgets/login#checking-authorization） */
export async function verifyTelegramLogin(
  botToken: string,
  data: TelegramLoginData,
): Promise<boolean> {
  const authDate = parseInt(data.auth_date, 10);
  if (Number.isNaN(authDate) || Date.now() / 1000 - authDate > TG_AUTH_MAX_AGE)
    return false;

  // data_check_string: alphabetically sorted key=value pairs (excluding hash)
  const checkString = Object.entries(data)
    .filter(([k]) => k !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  // secret_key = SHA256(bot_token)
  const tokenHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(botToken),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    tokenHash,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(checkString),
  );
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expected, data.hash);
}

// ── Session cookie ──────────────────────────────────────────────────────────

/** 生成 session cookie 值: telegramId:timestamp:hmac */
export async function generateSessionCookie(
  secret: string,
  telegramId: string,
): Promise<{ value: string; maxAge: number }> {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${telegramId}:${ts}`;
  const hmac = await hmacSha256Hex(secret, payload, 32);
  return { value: `${payload}:${hmac}`, maxAge: SESSION_TTL };
}

/** 验证 session cookie，返回 telegramId 或 null */
export async function verifySessionCookie(
  secret: string,
  cookie: string,
): Promise<string | null> {
  const parts = cookie.split(":");
  if (parts.length !== 3) return null;
  const [telegramId, tsStr, hmac] = parts;
  const ts = parseInt(tsStr, 10);
  if (Number.isNaN(ts) || Date.now() / 1000 - ts > SESSION_TTL) return null;

  const expected = await hmacSha256Hex(secret, `${telegramId}:${tsStr}`, 32);
  if (!timingSafeEqual(expected, hmac)) return null;
  return telegramId;
}
