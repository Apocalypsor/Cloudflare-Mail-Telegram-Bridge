/**
 * 领域常量：前后端都认可的值，和 URL/API 无关。
 *
 * `MAIL_LIST_TYPES` 有意和 `@worker/services/mail-list` 里的同名常量保持一致
 * —— 复制而不是从 Worker 导入，是因为那个文件带大量运行时 import（`@db/...`
 * 等），一跟着就会把 Worker bundle 拖进前端 chunk。这里只要字面量的 tuple，
 * 手动同步即可。
 */
export const MAIL_LIST_TYPES = [
  "unread",
  "starred",
  "junk",
  "archived",
] as const;

/** 列表类型的中文标题（前端展示用） */
export const MAIL_LIST_TITLES = {
  unread: "📬 未读邮件",
  starred: "⭐ 星标邮件",
  junk: "🚫 垃圾邮件",
  archived: "📥 归档邮件",
} as const;
