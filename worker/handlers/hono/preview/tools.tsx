import { requireTelegramLogin } from "@handlers/hono/middleware";
import { ROUTE_JUNK_CHECK_API, ROUTE_PREVIEW_API } from "@handlers/hono/routes";
import { analyzeEmail } from "@services/llm";
import { formatBody } from "@utils/format";
import type { Hono } from "hono";
import { MAX_BODY_CHARS } from "@/constants";
import type { AppEnv } from "@/types";

/** 注册 LLM tool 路由：HTML 格式化预览 + 垃圾邮件检测。
 *  页面已搬到 Pages（page/src/routes/{preview,junk-check}.tsx），只留 API。 */
export function registerToolRoutes(app: Hono<AppEnv>): void {
  const loginGuard = requireTelegramLogin();

  // ─── HTML 格式化预览工具 ─────────────────────────────────────────────────────
  app.post(ROUTE_PREVIEW_API, loginGuard, async (c) => {
    const { html } = await c.req.json<{ html?: string }>();
    if (!html) return c.json({ result: "", length: 0 });
    const result = formatBody(undefined, html, MAX_BODY_CHARS);
    return c.json({ result, length: result.length });
  });

  // ─── 垃圾邮件检测工具 ────────────────────────────────────────────────────────
  app.post(ROUTE_JUNK_CHECK_API, loginGuard, async (c) => {
    const { subject, body } = await c.req.json<{
      subject?: string;
      body?: string;
    }>();
    if (!c.env.LLM_API_URL || !c.env.LLM_API_KEY || !c.env.LLM_MODEL)
      return c.json({ error: "LLM not configured" }, 500);
    const result = await analyzeEmail(
      c.env.LLM_API_URL,
      c.env.LLM_API_KEY,
      c.env.LLM_MODEL,
      subject ?? "",
      body ?? "",
    );
    return c.json({
      isJunk: result.isJunk,
      junkConfidence: result.junkConfidence,
      summary: result.summary,
      tags: result.tags,
    });
  });
}
