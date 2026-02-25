export interface Env {
	/** Telegram Bot Token */
	TG_TOKEN: string;
	/** Telegram Chat ID */
	CHAT_ID: string;
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
	/** KV 命名空间 */
	EMAIL_KV: KVNamespace;
}

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
