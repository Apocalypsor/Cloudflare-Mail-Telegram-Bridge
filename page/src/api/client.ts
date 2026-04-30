import { treaty } from "@elysiajs/eden";
import { getInitData } from "@page/providers/telegram";
import type { App } from "@worker/api";

/**
 * Eden treaty client typed against the worker's `App` —— 路径、body、query、
 * 响应都从 worker 的 Elysia 路由 / TypeBox 模型自动推导，无需重复声明 schema。
 *
 * 自动给所有请求带上：
 *  - `X-Telegram-Init-Data` 头（Mini App `requireMiniAppAuth` 用）
 *  - `credentials: "same-origin"`（web 页面 session cookie 自动带）
 *
 * Origin: dev 走 Vite :5173（proxy 转发 /api/*），生产走 Pages + Worker
 * Routes 同域。`window.location.origin` 两处都对。
 */
export const api = treaty<App>(
  typeof window !== "undefined" ? window.location.origin : "http://localhost",
  {
    headers: () => {
      const initData = getInitData();
      return initData ? { "X-Telegram-Init-Data": initData } : {};
    },
    fetch: { credentials: "same-origin" },
  },
);
