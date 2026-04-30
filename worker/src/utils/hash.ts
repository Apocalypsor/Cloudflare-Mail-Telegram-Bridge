/** 常量时间字符串比较，防止计时攻击 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

/**
 * HMAC-SHA256(secret, data) → 十六进制字符串，可选截断前 N 字符。
 * 项目里多处用这个模式签名（mail 预览 token / session cookie）。
 * `truncate` 默认 0 = 完整 64 字符；常用 32 字符截断出紧凑签名。
 */
export async function hmacSha256Hex(
  secret: string,
  data: string,
  truncate = 0,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return truncate > 0 ? hex.slice(0, truncate) : hex;
}
