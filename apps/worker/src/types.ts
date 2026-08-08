import type { accounts, users } from "@worker/db/schema";
import type { TelegramRateLimiter } from "@worker/durable-objects/telegram-rate-limiter";

/** 用 const + 类型别名替代 enum —— 这样字面量值就是 string literal type，跟 Drizzle
 *  schema 的 `text({ enum: [...] })` 推出来的 union 类型完全对齐，免掉强转。
 *  调用方 `AccountType.Gmail` 用法不变。 */
export const AccountType = {
  Gmail: "gmail",
  Imap: "imap",
  Outlook: "outlook",
} as const;
export type AccountType = (typeof AccountType)[keyof typeof AccountType];

/** D1 accounts / users 表记录 —— Drizzle 推断，schema.ts 是真相来源，字段语义注解
 *  也写在那里（IMAP only / archive_folder / disabled 等）。 */
export type Account = typeof accounts.$inferSelect;
export type TelegramUser = typeof users.$inferSelect;
export type WaitUntil = (promise: Promise<unknown>) => void;

interface WorkerSecrets {
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
  /** OpenAI Responses API base URL，例如 https://api.openai.com/v1（可选，不配置则跳过 AI 摘要） */
  LLM_API_URL?: string;
  /** OpenAI API key */
  LLM_API_KEY?: string;
  /** LLM 模型名称 */
  LLM_MODEL?: string;
  /** Things Cloud API endpoint override（调试用，默认 https://cloud.culturedcode.com） */
  THINGS_CLOUD_ENDPOINT?: string;
  /** Telegram Webhook Secret（校验 webhook 来源） */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Worker 对外访问 URL，例如 https://gmail-tg-bridge.xxx.workers.dev（用于生成邮件查看链接） */
  WORKER_URL: string;
  /** Microsoft OAuth2 Client ID（Outlook 支持） */
  MS_CLIENT_ID?: string;
  /** Microsoft OAuth2 Client Secret */
  MS_CLIENT_SECRET?: string;
  /** Microsoft Graph webhook 共享密钥，校验通知来源 */
  MS_WEBHOOK_SECRET?: string;
  /** Domain routed to this Worker's Email Routing handler, e.g. in.telemail.example.com */
  IMAP_FORWARD_DOMAIN?: string;
  /**
   * BotFather `/newapp` 注册的 Mini App short_name（如 `dovmailui`）。
   * 用于群聊里 ⏰ 按钮的 deep link `t.me/<bot>/<short_name>?startapp=...`。
   * 未配置时群聊场景不显示 ⏰（私聊不受影响）。
   * Mini App 的实际 URL 在 BotFather 里设；本变量只是它的短名。
   */
  TG_MINI_APP_SHORT_NAME?: string;
}

type RefinedBindings = Omit<Cloudflare.Env, "TELEGRAM_RATE_LIMITER"> & {
  /** Durable Object：统一协调 Telegram API 限流窗口 */
  TELEGRAM_RATE_LIMITER: DurableObjectNamespace<TelegramRateLimiter>;
};

/** Worker runtime env：binding 来源于 `wrangler types` 生成的 `Cloudflare.Env`；
 *  secrets 不在 wrangler config 中声明，单独补充。 */
export type Env = RefinedBindings & WorkerSecrets;

/** 邮件元数据（发件人/收件人/主题/日期） */
export interface MailMeta {
  subject?: string | null;
  from?: string | null;
  to?: string | null;
  date?: Date | null;
}

/** 邮件预览页展示用附件元数据。不含二进制内容。 */
export interface MailAttachmentMeta {
  id: string;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
}

export interface MailAttachmentDownload {
  filename: string | null;
  mimeType: string | null;
  body: string | ArrayBuffer | ReadableStream<Uint8Array>;
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
