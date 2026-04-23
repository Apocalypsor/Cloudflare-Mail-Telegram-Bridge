// Web UI 路径。Worker 端 bot keyboards 也写了一份（src/handlers/hono/routes.ts），
// 改这里要同步那边。
export const ROUTE_MINI_APP = "/telegram-app";
export const ROUTE_MINI_APP_REMINDERS = "/telegram-app/reminders";
export const ROUTE_MINI_APP_MAIL = "/telegram-app/mail/:id";
export const ROUTE_MINI_APP_LIST = "/telegram-app/list/:type";
