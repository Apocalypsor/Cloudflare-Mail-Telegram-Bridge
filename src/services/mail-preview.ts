import { createHmac } from "node:crypto";
import { getCachedMailData, putCachedMailData } from "@db/kv";
import { ROUTE_CORS_PROXY } from "@handlers/hono/routes";
import { getEmailProvider, PROVIDERS } from "@providers";
import { timingSafeEqual } from "@utils/hash";
import type { Attachment } from "postal-mime";
import type { Account, Env, MailMeta } from "@/types";

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
async function generateMailToken(
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

/** 生成邮件 web 预览链接（已签名）。`folder` 用于告诉预览页从哪个文件夹取邮件（仅 IMAP 需要）。 */
export async function buildMailPreviewUrl(
  workerUrl: string,
  adminSecret: string,
  emailId: string,
  accountId: number,
  folder?: "inbox" | "junk" | "archive",
): Promise<string> {
  const token = await generateMailTokenById(adminSecret, emailId, accountId);
  return buildWebMailUrl(workerUrl, emailId, accountId, token, folder);
}

/** Web 版邮件页 URL（已有 token 时复用，避免重复签名） */
export function buildWebMailUrl(
  workerUrl: string,
  emailId: string,
  accountId: number,
  token: string,
  folder?: "inbox" | "junk" | "archive",
): string {
  const base = `${workerUrl.replace(/\/$/, "")}/mail/${encodeURIComponent(emailId)}?accountId=${accountId}&t=${encodeURIComponent(token)}`;
  return folder ? `${base}&folder=${folder}` : base;
}

/** Mini App 版邮件页 URL（与 ROUTE_MINI_APP_MAIL 同步） */
export function buildMiniAppMailUrl(
  workerUrl: string,
  emailId: string,
  accountId: number,
  token: string,
): string {
  return `${workerUrl.replace(/\/$/, "")}/telegram-app/mail/${encodeURIComponent(emailId)}?accountId=${accountId}&t=${encodeURIComponent(token)}`;
}

/** Mini App 版提醒页 URL（与 ROUTE_MINI_APP_REMINDERS 同步） */
export function buildMiniAppRemindersUrl(
  workerUrl: string,
  emailId: string,
  accountId: number,
  token: string,
): string {
  return `${workerUrl.replace(/\/$/, "")}/telegram-app/reminders?accountId=${accountId}&messageId=${encodeURIComponent(emailId)}&token=${encodeURIComponent(token)}`;
}

// ─── 邮件预览数据加载（web /mail/:id 和 mini app /telegram-app/mail/:id 共用） ─

type Folder = "inbox" | "junk" | "archive";

export type LoadedMailPreview =
  | {
      ok: true;
      meta: MailMeta;
      /** 已经做完 CID 内联 + 图片代理改写的 HTML，渲染层直接 raw() 即可 */
      proxiedHtml: string;
      fetchFolder: Folder;
      inJunk: boolean;
      starred: boolean;
    }
  | { ok: false; status: 403 | 404; reason: string };

/** 拿邮件渲染所需的全部数据：folder 推断 → KV 缓存命中或 provider 现拉
 *  → CID 内联 → 写回 KV → 图片代理。两个 mail 页 handler 共享同一份逻辑。 */
export async function loadMailForPreview(
  env: Env,
  account: Account,
  messageId: string,
  folderHint?: string,
): Promise<LoadedMailPreview> {
  const provider = getEmailProvider(account, env);
  const [inJunk, starred] = await Promise.all([
    provider.isJunk(messageId).catch(() => false),
    provider.isStarred(messageId).catch(() => false),
  ]);
  const fetchFolder: Folder =
    folderHint === "archive"
      ? "archive"
      : folderHint === "junk" || inJunk
        ? "junk"
        : "inbox";

  const cached = await getCachedMailData(
    env.EMAIL_KV,
    account.id,
    fetchFolder,
    messageId,
  );
  if (cached) {
    return {
      ok: true,
      meta: cached.meta ?? {},
      proxiedHtml: await proxyImages(cached.html, env.ADMIN_SECRET),
      fetchFolder,
      inJunk,
      starred,
    };
  }

  if (PROVIDERS[account.type].oauth && !account.refresh_token)
    return { ok: false, status: 403, reason: "Account not authorized" };

  const result = await provider.fetchForPreview(messageId, fetchFolder);
  if (!result)
    return { ok: false, status: 404, reason: "No content in this email" };

  const html = replaceCidReferences(result.html, result.cidMap);
  await putCachedMailData(env.EMAIL_KV, account.id, fetchFolder, messageId, {
    html,
    meta: result.meta,
  });
  return {
    ok: true,
    meta: result.meta ?? {},
    proxiedHtml: await proxyImages(html, env.ADMIN_SECRET),
    fetchFolder,
    inJunk,
    starred,
  };
}
