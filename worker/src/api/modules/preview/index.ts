import { authSession } from "@worker/api/plugins/auth-session";
import { cf } from "@worker/api/plugins/cf";
import { http } from "@worker/clients/http";
import { analyzeEmail } from "@worker/clients/llm";
import { MAX_BODY_CHARS } from "@worker/constants";
import { formatBody } from "@worker/utils/format";
import { verifyProxySignature } from "@worker/utils/mail-html";
import { Elysia } from "elysia";
import { HTTPError } from "ky";
import { JunkCheckBody, PreviewBody, ProxyQuery } from "./model";

/**
 * 预览类工具：HTML 格式化预览 + 垃圾邮件检测 + CORS 代理。
 *
 *  - GET  /api/cors-proxy    ADMIN_SECRET 签名校验（邮件正文里远端图片绕跨域）
 *  - POST /api/preview       session cookie 鉴权（web 工具页）
 *  - POST /api/junk-check    session cookie 鉴权（web 工具页）
 *
 * 路由排在 `.use(authSession)` 之前的不走 session check，之后的都走 ——
 * Elysia 的 plugin 顺序就是 guard 边界。
 */
export const previewController = new Elysia({ name: "controller.preview" })
  .use(cf)

  // CORS proxy —— 邮件预览页（Pages SPA）渲染图片时浏览器直接发 GET。
  // url + sig 由 verifyProxySignature 用 ADMIN_SECRET 校验，不需要登录态。
  .get(
    "/api/cors-proxy",
    async ({ env, query, status }) => {
      const { url, sig } = query;
      if (!verifyProxySignature(env.ADMIN_SECRET, url, sig))
        return status(403, "Invalid signature");

      try {
        const resp = await http.get(url);
        const contentType =
          resp.headers.get("content-type") ?? "application/octet-stream";
        return new Response(resp.body, {
          headers: {
            "content-type": contentType,
            "cache-control": "public, max-age=86400",
          },
        });
      } catch (err) {
        if (err instanceof HTTPError) {
          return status(err.response.status as 502, "Upstream error");
        }
        return status(502, "Failed to fetch image");
      }
    },
    { query: ProxyQuery },
  )

  // ─── 以下路由都要 session cookie ───────────────────────────────────
  .use(authSession)

  // HTML → MarkdownV2 预览
  .post(
    "/api/preview",
    ({ body }) => {
      const html = body.html;
      if (!html) return { result: "", length: 0 };
      const result = formatBody(undefined, html, MAX_BODY_CHARS);
      return { result, length: result.length };
    },
    { body: PreviewBody },
  )

  // 垃圾邮件检测
  .post(
    "/api/junk-check",
    async ({ env, body, status }) => {
      if (!env.LLM_API_URL || !env.LLM_API_KEY || !env.LLM_MODEL)
        return status(500, { error: "LLM not configured" });
      const result = await analyzeEmail(
        env.LLM_API_URL,
        env.LLM_API_KEY,
        env.LLM_MODEL,
        body.subject ?? "",
        body.body ?? "",
      );
      return {
        isJunk: result.isJunk,
        junkConfidence: result.junkConfidence,
        summary: result.summary,
        tags: result.tags,
      };
    },
    { body: JunkCheckBody },
  );
