import type { ObservabilityHubBinding } from "workers-observability-hub";

export enum AccountType {
  Gmail = "gmail",
  Imap = "imap",
  Outlook = "outlook",
}

/** D1 accounts 表记录 */
export interface Account {
  id: number;
  type: AccountType;
  email: string | null;
  chat_id: string;
  refresh_token: string | null;
  telegram_user_id: string | null;
  /** IMAP only */
  imap_host: string | null;
  imap_port: number | null;
  imap_secure: number | null; // 0 | 1
  imap_user: string | null;
  imap_pass: string | null;
  /** 归档目标：Gmail = label ID（NULL 时禁用归档）；IMAP = 文件夹名（NULL 时回退到 "Archive"）；Outlook 不用 */
  archive_folder: string | null;
  created_at: string;
  updated_at: string;
}

/** D1 users 表记录（登录过的 Telegram 用户） */
export interface TelegramUser {
  telegram_id: string;
  first_name: string;
  last_name: string | null;
  username: string | null;
  photo_url: string | null;
  approved: number;
  last_login_at: string;
  created_at: string;
}

/** Hono context variables set by session middleware */
export interface SessionVariables {
  userId: string;
  isAdmin: boolean;
}

/** Hono app type with session variables */
export type AppEnv = {
  Bindings: Env;
  Variables: SessionVariables;
};

export interface Env {
  /** 由 webhook handler 注入，用于在响应后执行后台任务 */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Worker 名称（用于日志/告警） */
  WORKER_NAME: string;
  /** Telegram Bot Token（环境变量 / wrangler secret） */
  TELEGRAM_BOT_TOKEN: string;
  /** Google OAuth2 Client ID */
  GMAIL_CLIENT_ID: string;
  /** Google OAuth2 Client Secret */
  GMAIL_CLIENT_SECRET: string;
  /** Pub/Sub topic 全名, e.g. projects/my-proj/topics/gmail-push */
  GMAIL_PUBSUB_TOPIC: string;
  /** URL 中的共享密钥，校验 Pub/Sub push 来源 */
  GMAIL_PUSH_SECRET: string;
  /** 管理密钥，用于 HMAC 签名（邮件查看链接、session cookie） */
  ADMIN_SECRET: string;
  /** Telegram 管理员 user ID，用于 Telegram Login 鉴权 */
  ADMIN_TELEGRAM_ID: string;
  /** KV 命名空间（access_token 缓存、消息去重、OAuth state） */
  EMAIL_KV: KVNamespace;
  /** D1 数据库（多账号信息） */
  DB: D1Database;
  /** Queue 绑定 */
  EMAIL_QUEUE: Queue<QueueMessage>;
  /** Observability Hub Service Binding */
  OBS_SERVICE: ObservabilityHubBinding;
  /** OpenAI compatible API base URL，例如 https://api.openai.com（可选，不配置则跳过 AI 摘要） */
  LLM_API_URL?: string;
  /** OpenAI compatible API key */
  LLM_API_KEY?: string;
  /** LLM 模型名称 */
  LLM_MODEL?: string;
  /** Telegram Webhook Secret（校验 webhook 来源） */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Worker 对外访问 URL，例如 https://gmail-tg-bridge.xxx.workers.dev（用于生成邮件查看链接） */
  WORKER_URL?: string;
  /** IMAP 中间件 URL，例如 https://middleware.example.com */
  IMAP_BRIDGE_URL?: string;
  /** IMAP 中间件共享密钥（Bearer token） */
  IMAP_BRIDGE_SECRET?: string;
  /** Microsoft OAuth2 Client ID（Outlook 支持） */
  MS_CLIENT_ID?: string;
  /** Microsoft OAuth2 Client Secret */
  MS_CLIENT_SECRET?: string;
  /** Microsoft Graph webhook 共享密钥，校验通知来源 */
  MS_WEBHOOK_SECRET?: string;
}

/** 邮件元数据（发件人/收件人/主题/日期） */
export interface MailMeta {
  subject?: string | null;
  from?: string | null;
  to?: string | null;
  date?: string | null;
}

/** 队列消息体 */
export interface QueueMessage {
  /** Gmail messageId 或 IMAP UID（字符串形式），出队时按账号类型分支处理 */
  accountId: number;
  messageId: string;
}

/** Pub/Sub push 请求体 */
export interface PubSubPushBody {
  message: { data: string; messageId: string; publishTime: string };
  subscription: string;
}

/** 邮件附件 */
export type Attachment = {
  filename?: string | null;
  mimeType?: string | null;
  content: string | ArrayBuffer | Uint8Array;
};
