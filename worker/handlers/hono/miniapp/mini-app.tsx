import { getCachedMailList, putCachedMailList } from "@db/kv";
import {
  ROUTE_MINI_APP_API_LIST,
  ROUTE_MINI_APP_API_MARK_ALL_READ,
  ROUTE_MINI_APP_API_SEARCH,
  ROUTE_MINI_APP_API_TRASH_ALL_JUNK,
} from "@handlers/hono/routes";
import { getMailList, isMailListType, searchMail } from "@services/mail-list";
import { markAllAsRead, trashAllJunkEmails } from "@services/message-actions";
import type { Hono } from "hono";
import type { AppEnv } from "@/types";

/** 注册 Mini App 通用 API 路由（list / mark-all-read / trash-all-junk / search）。
 *  鉴权由父级 `requireMiniAppAuth` 中间件统一处理。 */
export function registerMiniAppRoutes(app: Hono<AppEnv>): void {
  // 列表 JSON API：复用 services/mail-list 同一份数据，bot 文本回复也走它。
  // 默认每次都拉新数据（保守，bot/refresh 等场景）；?cache=true 时优先 KV（60s TTL，
  // Mini App 默认调用带这个 flag，强制刷新按钮去掉）。
  app.get(ROUTE_MINI_APP_API_LIST, async (c) => {
    const userId = c.get("userId");
    const type = c.req.param("type");
    if (!isMailListType(type))
      return c.json({ error: "Unknown list type" }, 400);

    const useCache = c.req.query("cache") === "true";
    if (useCache) {
      const cached = await getCachedMailList(c.env.EMAIL_KV, userId, type);
      if (cached)
        return c.body(cached, 200, { "content-type": "application/json" });
    }

    const result = await getMailList(c.env, userId, type);
    // 副作用（starred 同步键盘 / junk 清 mapping）后台跑，不阻塞响应
    if (result.pendingSideEffects.length > 0) {
      c.executionCtx.waitUntil(
        Promise.allSettled(result.pendingSideEffects.map((t) => t())),
      );
    }
    const json = JSON.stringify({
      type: result.type,
      results: result.results,
      total: result.total,
    });
    // 总是写 KV：哪怕这次是强制刷新，也让下一次 cache=true 拿到新鲜的
    c.executionCtx.waitUntil(
      putCachedMailList(c.env.EMAIL_KV, userId, type, json).catch(() => {}),
    );
    return c.body(json, 200, { "content-type": "application/json" });
  });

  // 一键已读 / 一键清垃圾：直接复用 services/message-actions 里 bot 也在用的实现，
  // 走 requireMiniAppAuth → c.var.userId 已校验。返回 { success, failed } 让客户端
  // 自己拼提示文案。
  app.post(ROUTE_MINI_APP_API_MARK_ALL_READ, async (c) => {
    const userId = c.get("userId");
    const result = await markAllAsRead(c.env, userId);
    return c.json(result);
  });

  app.post(ROUTE_MINI_APP_API_TRASH_ALL_JUNK, async (c) => {
    const userId = c.get("userId");
    const result = await trashAllJunkEmails(c.env, userId);
    return c.json(result);
  });

  // 跨账号邮件搜索 —— 结果形状跟 list API 一样，前端可复用渲染。
  // 鉴权由 `/api/mini-app/*` 中间件 (`requireMiniAppAuth`) 完成；只搜当前用户
  // 自己 enabled 的账号，所以无需额外授权检查。
  app.get(ROUTE_MINI_APP_API_SEARCH, async (c) => {
    const userId = c.get("userId");
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ error: "缺少搜索关键词" }, 400);
    if (q.length > 200) return c.json({ error: "关键词过长" }, 400);

    const result = await searchMail(c.env, userId, q);
    return c.json(result);
  });
}
