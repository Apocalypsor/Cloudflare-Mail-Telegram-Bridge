import { timingSafeEqual } from "@worker/utils/hash";

/** Telegram Mini App 用户信息（来自 initData 的 user 字段） */
interface TgWebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

async function hmacSha256(
  keyBytes: Uint8Array | ArrayBuffer,
  data: string,
): Promise<Uint8Array> {
  const buf =
    keyBytes instanceof ArrayBuffer
      ? keyBytes
      : (keyBytes.buffer.slice(
          keyBytes.byteOffset,
          keyBytes.byteOffset + keyBytes.byteLength,
        ) as ArrayBuffer);
  const key = await crypto.subtle.importKey(
    "raw",
    buf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return new Uint8Array(sig);
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

/**
 * 校验 Telegram Mini App initData。规范见
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * - secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
 * - hash       = HMAC_SHA256(key=secret_key, message=data_check_string)
 * data_check_string 由除 `hash` 外的所有 key=value 按字母序拼接，行分隔符 `\n`。
 *
 * 通过则返回 user，并带 maxAgeSeconds 限制 auth_date 防重放。
 */
export async function verifyTgInitData(
  botToken: string,
  initData: string,
  maxAgeSeconds = 24 * 3600,
): Promise<TgWebAppUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const entries: [string, string][] = [];
  for (const [k, v] of params) entries.push([k, v]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = await hmacSha256(
    new TextEncoder().encode("WebAppData"),
    botToken,
  );
  const computed = await hmacSha256(secretKey, dataCheckString);
  if (!timingSafeEqual(bytesToHex(computed), hash)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;

  const userStr = params.get("user");
  if (!userStr) return null;
  try {
    const user = JSON.parse(userStr) as TgWebAppUser;
    if (typeof user.id !== "number") return null;
    return user;
  } catch {
    return null;
  }
}
