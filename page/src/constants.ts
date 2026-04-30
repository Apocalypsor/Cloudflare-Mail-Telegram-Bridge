// 手动镜像 worker/src/utils/mail-list.ts 的同名 tuple —— 不 import 是为了不把
// worker 运行时依赖（D1 等）拖进前端 bundle。
export const MAIL_LIST_TYPES = [
  "unread",
  "starred",
  "junk",
  "archived",
] as const;

export const MAIL_LIST_TITLES = {
  unread: "📬 未读邮件",
  starred: "⭐ 星标邮件",
  junk: "🚫 垃圾邮件",
  archived: "📥 归档邮件",
} as const;
