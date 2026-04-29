import { requireMiniAppAuth } from "@handlers/hono/middleware";
import { ROUTE_REMINDERS_API } from "@handlers/hono/routes";
import { Hono } from "hono";
import type { AppEnv } from "@/types";
import { registerMiniAppRoutes } from "./mini-app";
import { registerReminderRoutes } from "./reminders";

// ─── Mini App API ──────────────────────────────────────────────────────────
// 鉴权策略：
//  - 本目录下的所有 API（/api/reminders/*, /api/mini-app/*）走 requireMiniAppAuth
//    中间件，统一在 c.var.userId 里给到鉴权用户（X-Telegram-Init-Data 头签名校验）。
//  - 邮件正文预览 API 是 GET /api/mail/:id，在 `preview.tsx` 里，走 token-only
//    （Web 浏览器里也能调，不需要 initData），不经这里的中间件。
//  - Mini App 页面（/telegram-app/*）本身由前端 SPA（Cloudflare Pages）渲染，
//    不在 Worker 上。方案 A：同域 + Workers Routes 分流 /api/* → Worker。

const miniapp = new Hono<AppEnv>();

miniapp.use("/api/reminders/*", requireMiniAppAuth);
miniapp.use(ROUTE_REMINDERS_API, requireMiniAppAuth);
miniapp.use("/api/mini-app/*", requireMiniAppAuth);

registerMiniAppRoutes(miniapp);
registerReminderRoutes(miniapp);

export default miniapp;
