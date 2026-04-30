import { createHmac } from "node:crypto";
import { timingSafeEqual } from "@worker/utils/hash";
import type { Attachment } from "postal-mime";

// ─── CID 内联图片 ────────────────────────────────────────────────────────────

/** CID → data URI 映射 */
type CidMap = Map<string, string>;

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
function signProxyUrl(secret: string, url: string): string {
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
  return `/api/cors-proxy?url=${encodeURIComponent(url)}&sig=${sig}`;
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
