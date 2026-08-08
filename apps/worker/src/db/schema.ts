/** Drizzle schema —— D1 表定义。和 `migrations/*.sql` 必须保持一致：
 *  现在 schema 是 source of truth for **TypeScript 类型推导**，但表结构改动仍走
 *  SQL migration（用 wrangler d1 migrations 跑）。
 *
 *  时间字段全部 `integer({ mode: "timestamp_ms" })` —— 存毫秒级 Unix epoch，
 *  Drizzle 读出来 wrap 成 `Date`、写入时调 `.getTime()`，自动双向转换。 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const tsMs = (name: string) => integer(name, { mode: "timestamp_ms" });
const nowDefault = sql`(CAST(strftime('%s', 'now') AS INTEGER) * 1000)`;

/** D1 accounts 表 */
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type", { enum: ["gmail", "imap", "outlook"] })
      .notNull()
      .default("gmail"),
    email: text("email"),
    chat_id: text("chat_id").notNull(),
    /** Telegram forum topic id for mail delivery. NULL = send to the chat's default destination. */
    topic_id: integer("topic_id"),
    refresh_token: text("refresh_token"),
    telegram_user_id: text("telegram_user_id"),
    /** IMAP only */
    imap_host: text("imap_host"),
    /** IMAP only */
    imap_port: integer("imap_port"),
    /** IMAP only —— 0 | 1 */
    imap_secure: integer("imap_secure"),
    /** IMAP only */
    imap_user: text("imap_user"),
    /** IMAP only */
    imap_pass: text("imap_pass"),
    /** IMAP forwarding local token, used by Cloudflare Email Routing as a push signal. */
    imap_forward_token: text("imap_forward_token"),
    created_at: tsMs("created_at").notNull().default(nowDefault),
    updated_at: tsMs("updated_at").notNull().default(nowDefault),
    history_id: text("history_id"),
    /** 归档目标：Gmail = label ID（NULL 时禁用归档）；IMAP = 文件夹名（NULL 时回退到 "Archive"）；Outlook 不用 */
    archive_folder: text("archive_folder"),
    /** 归档目标的人类可读名称（仅 Gmail 需要：label ID 用户不可读，存这份用于 UI 展示） */
    archive_folder_name: text("archive_folder_name"),
    /** 1 = 暂停：push/后台投递/定时任务/列表都会跳过；账号配置保留，可随时恢复 */
    disabled: integer("disabled").notNull().default(0),
  },
  (t) => [
    uniqueIndex("idx_accounts_imap_forward_token").on(t.imap_forward_token),
  ],
);

/** D1 users 表（登录过的 Telegram 用户） */
export const users = sqliteTable(
  "users",
  {
    telegram_id: text("telegram_id").primaryKey(),
    first_name: text("first_name").notNull(),
    last_name: text("last_name"),
    username: text("username"),
    photo_url: text("photo_url"),
    last_login_at: tsMs("last_login_at").notNull().default(nowDefault),
    created_at: tsMs("created_at").notNull().default(nowDefault),
    approved: integer("approved").notNull().default(0),
    /** Things Cloud per-user settings. Password is never returned by public APIs. */
    things_cloud_email: text("things_cloud_email"),
    things_cloud_password: text("things_cloud_password"),
    /** Last IANA time zone reported by the user's Mini App device. */
    user_timezone: text("user_timezone"),
    /** HMAC hash of the user's current MCP API key. Plain key is shown once by bot. */
    mcp_api_key_hash: text("mcp_api_key_hash"),
    /** Last MCP API key generation time. */
    mcp_api_key_created_at: tsMs("mcp_api_key_created_at"),
  },
  (t) => [uniqueIndex("idx_users_mcp_api_key_hash").on(t.mcp_api_key_hash)],
);

export const messageMap = sqliteTable(
  "message_map",
  {
    tg_message_id: integer("tg_message_id").notNull(),
    tg_chat_id: text("tg_chat_id").notNull(),
    /** Telegram forum topic id where this message was posted. NULL for non-topic chats. */
    tg_thread_id: integer("tg_thread_id"),
    email_message_id: text("email_message_id").notNull(),
    account_id: integer("account_id").notNull(),
    created_at: tsMs("created_at").notNull().default(nowDefault),
    short_summary: text("short_summary"),
  },
  (t) => [
    primaryKey({ columns: [t.tg_chat_id, t.tg_message_id] }),
    uniqueIndex("idx_message_map_email_unique").on(
      t.account_id,
      t.email_message_id,
    ),
  ],
);

/** 自动投递的短生命周期抢占状态；成功后由 message_map 接管并删除本行。 */
export const emailDeliveries = sqliteTable(
  "email_deliveries",
  {
    account_id: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    email_message_id: text("email_message_id").notNull(),
    state: text("state", {
      enum: ["pending", "sending", "retryable", "unknown"],
    })
      .notNull()
      .default("pending"),
    created_at: tsMs("created_at").notNull().default(nowDefault),
    updated_at: tsMs("updated_at").notNull().default(nowDefault),
  },
  (t) => [
    primaryKey({ columns: [t.account_id, t.email_message_id] }),
    index("idx_email_deliveries_state_updated_at").on(t.state, t.updated_at),
  ],
);

export const failedEmails = sqliteTable(
  "failed_emails",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    account_id: integer("account_id").notNull(),
    email_message_id: text("email_message_id").notNull(),
    tg_chat_id: text("tg_chat_id").notNull(),
    tg_message_id: integer("tg_message_id").notNull(),
    is_caption: integer("is_caption").notNull().default(0),
    subject: text("subject"),
    error_message: text("error_message"),
    created_at: tsMs("created_at").notNull().default(nowDefault),
  },
  // 跟 migration 0007 / 0024 的 inline `UNIQUE(...)` 对齐 —— 表级约束、无独立命名
  // 索引（SQLite 自动建 sqlite_autoindex_failed_emails_*）。`uniqueIndex` 会另开
  // 一个 CREATE UNIQUE INDEX，跟实际 DDL 不一致。
  (t) => [unique().on(t.email_message_id, t.tg_message_id)],
);

export const reminders = sqliteTable(
  "reminders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    telegram_user_id: text("telegram_user_id").notNull(),
    text: text("text").notNull(),
    remind_at: tsMs("remind_at").notNull(),
    sent_at: tsMs("sent_at"),
    created_at: tsMs("created_at").notNull().default(nowDefault),
    account_id: integer("account_id"),
    email_message_id: text("email_message_id"),
    email_subject: text("email_subject"),
    tg_chat_id: text("tg_chat_id"),
    tg_message_id: integer("tg_message_id"),
    things_task_id: text("things_task_id"),
  },
  (t) => [
    index("idx_reminders_due").on(t.sent_at, t.remind_at),
    index("idx_reminders_user").on(t.telegram_user_id),
  ],
);
