/**
 * Worker 定义的 API endpoint 路径常量 —— 前端调 `api.get(path)` / `api.post(path)`
 * 用。这些都是 Worker 那边 Hono 注册的真正可调用 URL（对应 wrangler routes
 * 里 `telemail.app/api/*` 映射过去的那些）。
 *
 * 从 `@worker/handlers/hono/routes` 原样再导出，Worker 改常量时前端自动跟上，
 * 不会漂移。纯字符串字面量，tree-shake 安全，不会把 Worker 运行时代码牵进
 * 前端 bundle。
 */
export {
  ROUTE_MINI_APP_API_LIST,
  ROUTE_MINI_APP_API_MAIL,
  ROUTE_MINI_APP_API_MARK_ALL_READ,
  ROUTE_MINI_APP_API_TRASH_ALL_JUNK,
  ROUTE_REMINDERS_API,
  ROUTE_REMINDERS_API_EMAIL_CONTEXT,
  ROUTE_REMINDERS_API_ITEM,
  ROUTE_REMINDERS_API_RESOLVE_CONTEXT,
} from "@worker/handlers/hono/routes";
