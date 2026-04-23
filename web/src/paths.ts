/**
 * 前端引用后端路由的单一入口：直接从 Worker 端 `src/handlers/hono/routes.ts`
 * 重导出（Vite 路径别名 `@worker/*` 指向 `../src/*`）。这些常量都是纯字符串
 * 字面量，tree-shake 后不会把 Worker 运行时代码打进前端 bundle。
 *
 * 改路径时只动 Worker 那一份，前端跟着自动对齐。
 */
export {
  ROUTE_MINI_APP,
  ROUTE_MINI_APP_API_LIST,
  ROUTE_MINI_APP_API_MAIL,
  ROUTE_MINI_APP_API_MARK_ALL_READ,
  ROUTE_MINI_APP_API_TRASH_ALL_JUNK,
  ROUTE_MINI_APP_LIST,
  ROUTE_MINI_APP_MAIL,
  ROUTE_MINI_APP_REMINDERS,
  ROUTE_REMINDERS_API,
  ROUTE_REMINDERS_API_EMAIL_CONTEXT,
  ROUTE_REMINDERS_API_ITEM,
  ROUTE_REMINDERS_API_RESOLVE_CONTEXT,
} from "@worker/handlers/hono/routes";

// 和 @worker/services/mail-list 里的 MAIL_LIST_TYPES 保持一致；重复而不是从
// Worker 导入是因为那个文件带大量运行时 import（@db/accounts 等），会把整个
// Worker bundle 拖进前端 chunk。MailListType union 在 schemas.ts 里用 zod enum
// 表达同一份真实源。
export const MAIL_LIST_TYPES = [
  "unread",
  "starred",
  "junk",
  "archived",
] as const;

/** 列表类型中文标题（前端展示用） */
export const MAIL_LIST_TITLES = {
  unread: "📬 未读邮件",
  starred: "⭐ 星标邮件",
  junk: "🚫 垃圾邮件",
  archived: "📥 归档邮件",
} as const;

/** 把带 :param 的路径模板替换成实际 URL */
export function resolvePath(
  pattern: string,
  params: Record<string, string | number>,
): string {
  return Object.entries(params).reduce(
    (acc, [k, v]) => acc.replace(`:${k}`, encodeURIComponent(String(v))),
    pattern,
  );
}
