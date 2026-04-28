import { z } from "zod";

// ─── Reminders API ──────────────────────────────────────────────────────────

export const reminderSchema = z.object({
  id: z.number(),
  telegram_user_id: z.string(),
  text: z.string(),
  remind_at: z.string(),
  account_id: z.number().nullable(),
  email_message_id: z.string().nullable(),
  email_subject: z.string().nullable(),
  tg_chat_id: z.string().nullable(),
  tg_message_id: z.number().nullable(),
  sent_at: z.string().nullable(),
  created_at: z.string(),
  /** 列表 API 附加：可用于跳到邮件预览页。通用提醒（无邮件上下文）为 null。 */
  mail_token: z.string().nullable().optional(),
  /** 列表 API 附加：message_map 里的 LLM 一句话摘要（最新值，比创建时快照新）。 */
  email_summary: z.string().nullable().optional(),
});
export type Reminder = z.infer<typeof reminderSchema>;

export const remindersListResponseSchema = z.object({
  reminders: z.array(reminderSchema),
});

export const emailContextResponseSchema = z.object({
  subject: z.string().nullable(),
  accountEmail: z.string().nullable(),
  deliveredToChat: z.string().nullable(),
});

export const resolveContextResponseSchema = z.object({
  accountId: z.number(),
  emailMessageId: z.string(),
  token: z.string(),
});

// ─── Mail list API ──────────────────────────────────────────────────────────

export const mailListItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  token: z.string(),
  tgChatId: z.string().optional(),
  tgMessageId: z.number().optional(),
  /** 仅 search API 填充：subject 缺失时也能看出是谁发的 */
  from: z.string().optional(),
});

export const mailListAccountResultSchema = z.object({
  accountId: z.number(),
  accountEmail: z.string().nullable(),
  items: z.array(mailListItemSchema),
  total: z.number(),
  error: z.string().optional(),
});

export const mailListTypeSchema = z.enum([
  "unread",
  "starred",
  "junk",
  "archived",
]);
export type MailListType = z.infer<typeof mailListTypeSchema>;

export const mailListResponseSchema = z.object({
  type: mailListTypeSchema,
  results: z.array(mailListAccountResultSchema),
  total: z.number(),
});

export const bulkActionResponseSchema = z.object({
  success: z.number(),
  failed: z.number(),
});

// ─── Search API (GET /api/mini-app/search?q=...) ────────────────────────────

export const mailSearchResponseSchema = z.object({
  query: z.string(),
  results: z.array(mailListAccountResultSchema),
  total: z.number(),
});

// ─── Mail preview API (新增：GET /api/mini-app/mail/:id) ─────────────────────

export const mailMetaSchema = z.object({
  subject: z.string().nullable().optional(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
});

export const mailPreviewResponseSchema = z.object({
  meta: mailMetaSchema,
  accountEmail: z.string().nullable(),
  /** 已走 CORS 代理改写的 HTML —— UI 默认渲染这个 */
  bodyHtml: z.string(),
  /** 未走代理的原始 HTML —— 用户在预览页关闭代理时渲染 */
  bodyHtmlRaw: z.string(),
  inJunk: z.boolean(),
  inArchive: z.boolean(),
  starred: z.boolean(),
  canArchive: z.boolean(),
  webMailUrl: z.string(),
  tgMessageLink: z.string().nullable(),
});
export type MailPreviewResponse = z.infer<typeof mailPreviewResponseSchema>;

// ─── HTML → MarkdownV2 preview tool (POST /api/preview) ─────────────────────

export const previewResponseSchema = z.object({
  result: z.string(),
  length: z.number(),
});

// ─── Junk classifier (POST /api/junk-check) ─────────────────────────────────

export const junkCheckResponseSchema = z.object({
  isJunk: z.boolean(),
  junkConfidence: z.number(),
  summary: z.string(),
  tags: z.array(z.string()),
  error: z.string().optional(),
});

// ─── Session ────────────────────────────────────────────────────────────────

export const whoamiResponseSchema = z.object({
  telegramId: z.string(),
  isAdmin: z.boolean(),
  firstName: z.string(),
  username: z.string().nullable(),
});
export type Whoami = z.infer<typeof whoamiResponseSchema>;

export const botInfoResponseSchema = z.object({
  botUsername: z.string(),
});

// ─── Generic { ok, error? } ─────────────────────────────────────────────────

export const okResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  message: z.string().optional(),
});
