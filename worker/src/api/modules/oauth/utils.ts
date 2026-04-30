import { PROVIDERS } from "@worker/providers";
import type { OAuthHandler } from "@worker/providers/types";
import type { AccountType } from "@worker/types";

/** 从 URL path param 解析对应 provider 的 OAuth handler；slug 未知 / 该 provider
 *  不支持 OAuth（如 IMAP）→ null。 */
export function resolveOAuth(slug: string): OAuthHandler | null {
  return PROVIDERS[slug as AccountType]?.oauth || null;
}
