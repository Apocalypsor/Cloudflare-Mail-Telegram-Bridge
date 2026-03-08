export interface SecretStoreSecretBinding {
	get(): Promise<string>;
}

export interface ObservabilityErrorPayload {
	source: string;
	event: string;
	message: string;
	stack?: string;
	context?: Record<string, unknown>;
	timestamp?: string;
}

export interface ObservabilityServiceBinding {
	reportError(payload: ObservabilityErrorPayload | null | undefined): Promise<void>;
}

/** D1 accounts 表记录 */
export interface Account {
	id: number;
	email: string | null;
	chat_id: string;
	refresh_token: string | null;
	label: string | null;
	created_at: string;
	updated_at: string;
}

export interface Env {
	/** Worker 名称（用于日志/告警） */
	WORKER_NAME: string;
	/** Telegram Bot Token */
	TG_TOKEN: SecretStoreSecretBinding;
	/** Google OAuth2 Client ID */
	GMAIL_CLIENT_ID: string;
	/** Google OAuth2 Client Secret */
	GMAIL_CLIENT_SECRET: string;
	/** Pub/Sub topic 全名, e.g. projects/my-proj/topics/gmail-push */
	GMAIL_PUBSUB_TOPIC: string;
	/** URL 中的共享密钥，校验 Pub/Sub push 来源 */
	GMAIL_PUSH_SECRET: string;
	/** 手动触发 watch 的共享密钥 */
	GMAIL_WATCH_SECRET: string;
	/** KV 命名空间（access_token 缓存、消息去重、OAuth state） */
	EMAIL_KV: KVNamespace;
	/** D1 数据库（多账号信息） */
	DB: D1Database;
	/** Queue 绑定 */
	EMAIL_QUEUE: Queue<QueueMessage>;
	/** Observability Hub Service Binding */
	OBS_SERVICE: ObservabilityServiceBinding;
	/** OpenAI compatible API base URL，例如 https://api.openai.com（可选，不配置则跳过 AI 摘要） */
	LLM_API_URL?: string;
	/** OpenAI compatible API key */
	LLM_API_KEY?: string;
	/** LLM 模型名称 */
	LLM_MODEL?: string;
}

/** 队列消息体 */
export type QueueMessage =
	| {
			type: 'sync';
			accountId: number;
			pubsubMessageId: string;
			historyId: string;
	  }
	| {
			type: 'message';
			accountId: number;
			messageId: string;
	  };

/** Pub/Sub push 请求体 */
export interface PubSubPushBody {
	message: { data: string; messageId: string; publishTime: string };
	subscription: string;
}

/** Gmail push 通知 payload (base64 解码后) */
export interface GmailNotification {
	emailAddress: string;
	historyId: string;
}

/** 邮件附件 */
export type Attachment = {
	filename?: string | null;
	mimeType?: string | null;
	content: string | ArrayBuffer;
};
