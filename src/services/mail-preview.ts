import { createHmac } from "node:crypto";
import { ROUTE_CORS_PROXY } from "@handlers/hono/routes";
import { timingSafeEqual } from "@utils/hash";
import type { Attachment } from "postal-mime";

// ─── CID 内联图片 ────────────────────────────────────────────────────────────

/** CID → data URI 映射 */
export type CidMap = Map<string, string>;

/** 将 HTML 中的 cid:xxx 引用替换为 data URI */
export function replaceCidReferences(html: string, cidMap: CidMap): string {
  if (cidMap.size === 0) return html;
  return html.replace(
    /cid:([^"'\s)]+)/gi,
    (match, cid) => cidMap.get(cid) ?? match,
  );
}

/** 从 postal-mime 附件列表中提取 CID 内联图片为 data URI */
export function buildCidMapFromAttachments(attachments: Attachment[]): CidMap {
  const cidMap: CidMap = new Map();
  for (const att of attachments) {
    if (att.contentId && att.mimeType.startsWith("image/")) {
      const cid = att.contentId.replace(/^<|>$/g, "");
      const bytes = new Uint8Array(att.content as ArrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++)
        binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      cidMap.set(cid, `data:${att.mimeType};base64,${b64}`);
    }
  }
  return cidMap;
}

// ─── CORS 代理签名 ───────────────────────────────────────────────────────────

/** 为 CORS 代理 URL 生成 HMAC-SHA256 签名（同步） */
export function signProxyUrl(secret: string, url: string): string {
  return createHmac("sha256", secret).update(url).digest("hex").slice(0, 32);
}

/** 验证 CORS 代理 URL 签名 */
export function verifyProxySignature(
  secret: string,
  url: string,
  signature: string,
): boolean {
  return timingSafeEqual(signProxyUrl(secret, url), signature);
}

/** 将外部 URL 改写为经由 CORS 代理（附带 HMAC 签名） */
function proxied(url: string, secret: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  const sig = signProxyUrl(secret, url);
  return `${ROUTE_CORS_PROXY}?url=${encodeURIComponent(url)}&sig=${sig}`;
}

/** 用 HTMLRewriter 将 HTML 中所有外部资源 URL 改写为经由 CORS 代理 */
export async function proxyImages(
  html: string,
  secret: string,
): Promise<string> {
  return new HTMLRewriter()
    .on("img", {
      element(el) {
        const src = el.getAttribute("src");
        if (src) el.setAttribute("src", proxied(src, secret));
        const srcset = el.getAttribute("srcset");
        if (srcset) {
          el.setAttribute(
            "srcset",
            srcset.replace(
              /(\S+)(\s+[\d.]+[wx])/g,
              (_, url, desc) => `${proxied(url, secret)}${desc}`,
            ),
          );
        }
      },
    })
    .on("source", {
      element(el) {
        const srcset = el.getAttribute("srcset");
        if (srcset) {
          el.setAttribute(
            "srcset",
            srcset.replace(
              /(\S+)(\s+[\d.]+[wx])/g,
              (_, url, desc) => `${proxied(url, secret)}${desc}`,
            ),
          );
        }
      },
    })
    .on("[style]", {
      element(el) {
        const style = el.getAttribute("style");
        if (style?.includes("url(")) {
          el.setAttribute(
            "style",
            style.replace(
              /url\(\s*(['"]?)(https?:\/\/[^)'"]+)\1\s*\)/gi,
              (_, q, url) => `url(${q}${proxied(url, secret)}${q})`,
            ),
          );
        }
      },
    })
    .transform(new Response(html))
    .text();
}

// ─── 邮件预览链接 token ──────────────────────────────────────────────────────

async function hmacHex(secret: string, data: string): Promise<string> {
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
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** 生成邮件查看链接的 HMAC-SHA256 token（旧格式：email + chatId） */
export async function generateMailToken(
  secret: string,
  messageId: string,
  accountEmail: string,
  chatId: string,
): Promise<string> {
  return hmacHex(secret, `${messageId}:${accountEmail}:${chatId}`);
}

/** 验证邮件查看链接的 token（旧格式） */
export async function verifyMailToken(
  secret: string,
  messageId: string,
  accountEmail: string,
  chatId: string,
  token: string,
): Promise<boolean> {
  const expected = await generateMailToken(
    secret,
    messageId,
    accountEmail,
    chatId,
  );
  return timingSafeEqual(expected, token);
}

/** 生成基于 accountId 的邮件查看链接 token（新格式：比 email+chatId 更简洁） */
export async function generateMailTokenById(
  secret: string,
  messageId: string,
  accountId: number,
): Promise<string> {
  return hmacHex(secret, `${messageId}:${accountId}`);
}

/** 验证基于 accountId 的邮件查看链接 token */
export async function verifyMailTokenById(
  secret: string,
  messageId: string,
  accountId: number,
  token: string,
): Promise<boolean> {
  const expected = await generateMailTokenById(secret, messageId, accountId);
  return timingSafeEqual(expected, token);
}

/** 生成邮件 web 预览链接（已签名） */
export async function buildMailPreviewUrl(
  workerUrl: string,
  adminSecret: string,
  emailId: string,
  accountId: number,
): Promise<string> {
  const token = await generateMailTokenById(adminSecret, emailId, accountId);
  return `${workerUrl.replace(/\/$/, "")}/mail/${emailId}?accountId=${accountId}&t=${token}`;
}
