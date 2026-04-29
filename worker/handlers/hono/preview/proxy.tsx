import { ROUTE_CORS_PROXY } from "@handlers/hono/routes";
import { http } from "@utils/http";
import { verifyProxySignature } from "@utils/mail-html";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPError } from "ky";
import type { AppEnv } from "@/types";

/** 通用 CORS 代理：邮件正文里的远端图片走这个代理，防止跨域拉不到。
 *  签名校验防滥用 —— URL 必须带 ADMIN_SECRET 签的 sig。 */
export function registerProxyRoutes(app: Hono<AppEnv>): void {
  app.get(ROUTE_CORS_PROXY, async (c) => {
    const url = c.req.query("url");
    const sig = c.req.query("sig");
    if (!url || !sig) return c.text("Missing url or sig", 400);
    if (!verifyProxySignature(c.env.ADMIN_SECRET, url, sig))
      return c.text("Invalid signature", 403);

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
      if (err instanceof HTTPError)
        return c.text(
          "Upstream error",
          err.response.status as ContentfulStatusCode,
        );
      return c.text("Failed to fetch image", 502);
    }
  });
}
