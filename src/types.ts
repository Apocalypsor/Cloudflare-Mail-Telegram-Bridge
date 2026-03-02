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

export interface Env {
	/** Worker 名称（用于日志/告警） */
	WORKER_NAME: string;
	/** Telegram Bot Token */
	TG_TOKEN: SecretStoreSecretBinding;
	/** Telegram Chat ID */
	CHAT_ID: SecretStoreSecretBinding;
	/** Google OAuth2 Client ID */
	GMAIL_CLIENT_ID: string;
	/** Google OAuth2 Client Secret */
	GMAIL_CLIENT_SECRET: string;
	/** Google OAuth2 Refresh Token */
	GMAIL_REFRESH_TOKEN: string;
	/** Gmail 邮箱地址 (用于日志) */
	GMAIL_USER_EMAIL: string;
	/** Pub/Sub topic 全名, e.g. projects/my-proj/topics/gmail-push */
	GMAIL_PUBSUB_TOPIC: string;
	/** URL 中的共享密钥，校验 Pub/Sub push 来源 */
	GMAIL_PUSH_SECRET: string;
	/** 手动触发 watch 的共享密钥 */
	GMAIL_WATCH_SECRET: string;
	/** KV 命名空间 */
	EMAIL_KV: KVNamespace;
	/** Queue 绑定 */
	EMAIL_QUEUE: Queue<QueueMessage>;
	/** Observability Hub Service Binding */
	OBS_SERVICE: ObservabilityServiceBinding;
}

/** 队列消息体 */
export type QueueMessage =
	| {
			type: 'sync';
			pubsubMessageId: string;
			historyId: string;
	  }
	| {
			type: 'message';
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
