import PostalMime from 'postal-mime';
import { KV_PROCESSED_PREFIX, MESSAGE_DATE_LOCALE, MESSAGE_DATE_TIMEZONE, PROCESSED_TTL_SECONDS } from '../constants';
import { formatBody } from '../lib/format';
import { escapeMdV2 } from '../lib/markdown-v2';
import type { Env, GmailNotification, PubSubPushBody, QueueMessage } from '../types';
import { base64urlToArrayBuffer, fetchNewMessageIds, getAccessToken, gmailGet, KV_HISTORY_ID } from './gmail';
import { summarizeEmail } from './ollama';
import { getTelegramSecrets } from './secrets';
import { editMessageCaption, editTextMessage, sendTextMessage, sendWithAttachments, TG_CAPTION_LIMIT, TG_MSG_LIMIT } from './telegram';

/** 解析 Pub/Sub 通知，将同步任务入队 */
export async function enqueueSyncNotification(body: PubSubPushBody, env: Env): Promise<void> {
	const decoded: GmailNotification = JSON.parse(atob(body.message.data));
	console.log(`Pub/Sub notification: email=${decoded.emailAddress}, historyId=${decoded.historyId}`);

	await env.EMAIL_QUEUE.send({
		type: 'sync',
		pubsubMessageId: body.message.messageId,
		historyId: decoded.historyId,
	});
}

/** 串行处理 Gmail history 同步，并将新 message id 入队 */
export async function processSyncNotification(sync: Extract<QueueMessage, { type: 'sync' }>, env: Env): Promise<void> {
	const token = await getAccessToken(env);
	const storedHistoryId = await env.EMAIL_KV.get(KV_HISTORY_ID);

	if (!storedHistoryId) {
		await env.EMAIL_KV.put(KV_HISTORY_ID, sync.historyId);
		console.log('Initialized historyId:', sync.historyId);
		return;
	}

	const messageIds = await fetchNewMessageIds(token, env, storedHistoryId);
	if (messageIds.length === 0) {
		console.log('无新邮件');
		return;
	}

	console.log(`发现 ${messageIds.length} 封新邮件，入队`);
	await env.EMAIL_QUEUE.sendBatch(messageIds.map((id) => ({ body: { type: 'message', messageId: id } })));
}

/** 串行消费消息 + 幂等防重 */
export async function processMessageNotification(messageId: string, env: Env): Promise<void> {
	const dedupeKey = `${KV_PROCESSED_PREFIX}${messageId}`;
	const processed = await env.EMAIL_KV.get(dedupeKey);
	if (processed) {
		console.log(`跳过重复消息: ${messageId}`);
		return;
	}

	const token = await getAccessToken(env);
	await processGmailMessage(token, messageId, env);

	await env.EMAIL_KV.put(dedupeKey, '1', {
		expirationTtl: PROCESSED_TTL_SECONDS,
	});
}

/** 获取单封 Gmail 邮件（raw 格式），解析并发送到 Telegram */
async function processGmailMessage(token: string, messageId: string, env: Env): Promise<void> {
	const { token: tgToken, chatId } = await getTelegramSecrets(env);

	const msg = await gmailGet(token, `/users/me/messages/${messageId}?format=raw`);
	const rawEmail = base64urlToArrayBuffer(msg.raw);
	const parser = new PostalMime();
	const email = await parser.parse(rawEmail);

	const subject = email.subject || '无主题';
	const header = buildTelegramHeader(email.from?.name || '', email.from?.address || '未知', subject);
	const hasAttachments = !!(email.attachments && email.attachments.length > 0);
	const charLimit = hasAttachments ? TG_CAPTION_LIMIT : TG_MSG_LIMIT;

	const ollamaUrl = env.OLLAMA_URL;
	const shouldSummarize = !!ollamaUrl;

	const overhead = header.length + 40;
	const bodyBudget = Math.max(charLimit - overhead, 100);
	const body = formatBody(email.text, email.html, bodyBudget);
	const text = header + body;

	// 发送原始消息
	let sentMessageId: number;
	if (hasAttachments) {
		sentMessageId = await sendWithAttachments(tgToken, chatId, text, email.attachments || []);
	} else {
		sentMessageId = await sendTextMessage(tgToken, chatId, text);
	}

	if (!shouldSummarize) return;

	// 发送后调用 Ollama 生成摘要，仅处理文字正文
	const rawBody = email.text || '';
	if (!rawBody.trim()) return;

	try {
		const model = env.OLLAMA_MODEL || 'qwen3.5:latest';
		const summary = await summarizeEmail(ollamaUrl, model, subject, rawBody);

		const summaryBody = `*${escapeMdV2('🤖 AI 摘要')}*\n\n${escapeMdV2(summary)}`;
		const finalText = header + summaryBody;
		const limit = hasAttachments ? TG_CAPTION_LIMIT : TG_MSG_LIMIT;
		const capped = finalText.length <= limit ? finalText : finalText.slice(0, limit);

		if (hasAttachments) {
			await editMessageCaption(tgToken, chatId, sentMessageId, capped);
		} else {
			await editTextMessage(tgToken, chatId, sentMessageId, capped);
		}
	} catch (err) {
		console.error('AI 摘要生成失败:', err);
	}
}

function buildTelegramHeader(fromName: string, fromAddress: string, subject: string): string {
	const date = new Date().toLocaleString(MESSAGE_DATE_LOCALE, { timeZone: MESSAGE_DATE_TIMEZONE });
	return [
		`*发件人:*  ${escapeMdV2(`${fromName} <${fromAddress}>`)}`,
		`*时  间:*  ${escapeMdV2(date)}`,
		`*主  题:*  ${escapeMdV2(subject)}`,
		``,
		``,
	].join('\n');
}
