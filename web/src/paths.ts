/**
 * Web UI 页面路径常量 —— 前端自己渲染的页面（`/telegram-app/*`），也被 bot
 * keyboards（Worker 端）用来生成链接给用户点进 Mini App。
 *
 * 虽然文件定义在 Worker 里（因为 bot keyboards 要用），但从 Web 视角这是
 * "页面路径"，和 API endpoints 属于不同域，单独列一份文件便于区分：
 *
 *   @/api/routes  → Worker API endpoints（`/api/*`）
 *   @/paths       → Web UI 页面（`/telegram-app/*`）
 */
export {
  ROUTE_MINI_APP,
  ROUTE_MINI_APP_LIST,
  ROUTE_MINI_APP_MAIL,
  ROUTE_MINI_APP_REMINDERS,
} from "@worker/handlers/hono/routes";
