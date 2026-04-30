// Mini App UI 路径常量 —— 真实路由由 TanStack Router 文件路由生成
// （`page/src/routes/telegram-app/*`），这里手动维护一份字符串镜像供 worker 拼
// `web_app` URL（`@page/paths` 是单一源头：改路径文件结构后这里同步，
// worker 端 `bot/handlers/{start,mail-list}.ts` 立刻类型报错）。
export const ROUTE_MINI_APP_REMINDERS = "/telegram-app/reminders";
export const ROUTE_MINI_APP_LIST = "/telegram-app/list/:type";
export const ROUTE_MINI_APP_SEARCH = "/telegram-app/search";
