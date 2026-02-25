import PostalMime from 'postal-mime';
import { escapeMdV2, formatBody } from './format';
import { base64urlToArrayBuffer, fetchNewMessageIds, getAccessToken, gmailGet, KV_HISTORY_ID, renewWatch } from './gmail';
import { sendTextMessage, sendWithAttachments, TG_CAPTION_LIMIT, TG_MSG_LIMIT } from './telegram';
import type { Env, GmailNotification, PubSubPushBody } from './types';

export type { Env } from './types';

// ─── Worker 入口 ─────────────────────────────────────────────────────────────

export default {
	/**
	 * HTTP handler:
	 *   POST /gmail/push?secret=XXX  — 接收 Pub/Sub 推送
	 *   POST /gmail/watch            — 手动触发 watch 注册
	 *   GET  /                        — 健康检查
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'POST' && url.pathname === '/gmail/push') {
			if (url.searchParams.get('secret') !== env.GMAIL_PUSH_SECRET) {
				return new Response('Forbidden', { status: 403 });
			}
			// 必须在返回 Response 之前读取 body，否则请求流会关闭
			const body = (await request.json()) as PubSubPushBody;
			ctx.waitUntil(handlePubSubPush(body, env));
			return new Response('OK');
		}

		if (request.method === 'POST' && url.pathname === '/gmail/watch') {
			try {
				await renewWatch(env);
				return new Response('Watch renewed');
			} catch (e: any) {
				return new Response(`Watch failed: ${e.message}`, { status: 500 });
			}
		}

		return new Response('Gmail → Telegram Bridge is running');
	},

	/**
	 * Cron handler: 每 6 天自动续订 Gmail watch
	 */
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(renewWatch(env));
	},
};

// ─── Pub/Sub push 处理 ──────────────────────────────────────────────────────

async function handlePubSubPush(body: PubSubPushBody, env: Env): Promise<void> {
	try {
		const decoded: GmailNotification = JSON.parse(atob(body.message.data));
		console.log(`Pub/Sub notification: email=${decoded.emailAddress}, historyId=${decoded.historyId}`);

		const token = await getAccessToken(env);
		const storedHistoryId = await env.EMAIL_KV.get(KV_HISTORY_ID);

		if (!storedHistoryId) {
			await env.EMAIL_KV.put(KV_HISTORY_ID, decoded.historyId);
			console.log('Initialized historyId:', decoded.historyId);
			return;
		}

		const messageIds = await fetchNewMessageIds(token, env, storedHistoryId);

		if (messageIds.length === 0) {
			console.log('无新邮件');
			return;
		}

		console.log(`发现 ${messageIds.length} 封新邮件`);
		for (const msgId of messageIds) {
			// 去重：检查是否已处理过
			const dedupeKey = `processed:${msgId}`;
			const already = await env.EMAIL_KV.get(dedupeKey);
			if (already) {
				console.log(`消息 ${msgId} 已处理过，跳过`);
				continue;
			}
			// 标记为已处理（TTL 24 小时，之后自动过期）
			await env.EMAIL_KV.put(dedupeKey, '1', { expirationTtl: 86400 });

			try {
				await processGmailMessage(token, msgId, env);
			} catch (e: any) {
				console.error(`处理消息 ${msgId} 失败:`, e.message);
			}
		}
	} catch (e: any) {
		console.error('handlePubSubPush 异常:', e.message);
	}
}

// ─── 邮件处理 ────────────────────────────────────────────────────────────────

/** 获取单封 Gmail 邮件（raw 格式），解析并发送到 Telegram */
async function processGmailMessage(token: string, messageId: string, env: Env): Promise<void> {
	const { TG_TOKEN, CHAT_ID } = env;

	const msg = await gmailGet(token, `/users/me/messages/${messageId}?format=raw`);
	const rawEmail = base64urlToArrayBuffer(msg.raw);

	const parser = new PostalMime();
	const email = await parser.parse(rawEmail);

	const from = email.from?.address || '未知';
	const fromName = email.from?.name || '';
	const subject = email.subject || '无主题';
	const date = new Date().toLocaleString('zh-CN', { timeZone: 'America/New_York' });

	const hasAttachments = email.attachments && email.attachments.length > 0;
	const charLimit = hasAttachments ? TG_CAPTION_LIMIT : TG_MSG_LIMIT;

	const header = [
		`*发件人:*  ${escapeMdV2(`${fromName} <${from}>`)}`,
		`*时  间:*  ${escapeMdV2(date)}`,
		`*主  题:*  ${escapeMdV2(subject)}`,
		``,
		``,
	].join('\n');

	const overhead = header.length + 40;
	const bodyBudget = Math.max(charLimit - overhead, 100);

	const body = formatBody(email.text, email.html, bodyBudget);
	const text = header + body;

	if (hasAttachments) {
		await sendWithAttachments(TG_TOKEN, CHAT_ID, text, email.attachments!);
	} else {
		await sendTextMessage(TG_TOKEN, CHAT_ID, text);
	}
}
