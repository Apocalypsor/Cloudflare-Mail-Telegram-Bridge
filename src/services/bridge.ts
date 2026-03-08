import PostalMime from 'postal-mime';
import { KV_PROCESSED_PREFIX, MESSAGE_DATE_LOCALE, MESSAGE_DATE_TIMEZONE, PROCESSED_TTL_SECONDS } from '../constants';
import { getAccountByEmail, getAccountById } from '../db/accounts';
import { getHistoryId, putHistoryId } from '../db/kv';
import { formatBody } from '../lib/format';
import { escapeMdV2 } from '../lib/markdown-v2';
import type { Account, Env, GmailNotification, PubSubPushBody, QueueMessage } from '../types';
import { base64urlToArrayBuffer, fetchNewMessageIds, getAccessToken, gmailGet } from './gmail';
import { summarizeEmail } from './ollama';
import { getTelegramToken } from './secrets';
import { editMessageCaption, editTextMessage, sendTextMessage, sendWithAttachments, TG_CAPTION_LIMIT, TG_MSG_LIMIT } from './telegram';

/** 解析 Pub/Sub 通知，根据 emailAddress 查找账号并入队 */
export async function enqueueSyncNotification(body: PubSubPushBody, env: Env): Promise<void> {
	const decoded: GmailNotification = JSON.parse(atob(body.message.data));
	console.log(`Pub/Sub notification: email=${decoded.emailAddress}, historyId=${decoded.historyId}`);

	const account = await getAccountByEmail(env.DB, decoded.emailAddress);
	if (!account) {
		console.log(`No account found for ${decoded.emailAddress}, skipping`);
		return;
	}

	await env.EMAIL_QUEUE.send({
		type: 'sync',
		accountId: account.id,
		pubsubMessageId: body.message.messageId,
		historyId: decoded.historyId,
	});
}

/** 少量邮件直接处理的阈值 */
const DIRECT_PROCESS_THRESHOLD = 3;

/** 按账号处理 Gmail history 同步，少量邮件直接处理，大批量才入队 */
export async function processSyncNotification(
	sync: Extract<QueueMessage, { type: 'sync' }>,
	env: Env,
	waitUntil?: (p: Promise<unknown>) => void,
): Promise<void> {
	const account = await getAccountById(env.DB, sync.accountId);
	if (!account) {
		console.log(`Account ${sync.accountId} not found, skipping sync`);
		return;
	}

	const token = await getAccessToken(env, account);

	const storedHistoryId = await getHistoryId(env, account.id);
	if (!storedHistoryId) {
		await putHistoryId(env, account.id, sync.historyId);
		console.log(`Initialized historyId for ${account.email}:`, sync.historyId);
		return;
	}

	const messageIds = await fetchNewMessageIds(token, env, account);
	if (messageIds.length === 0) {
		console.log(`No new messages for ${account.email}`);
		return;
	}

	// 少量邮件直接处理，减少一跳延迟；大批量仍走队列
	if (messageIds.length <= DIRECT_PROCESS_THRESHOLD && waitUntil) {
		console.log(`Found ${messageIds.length} new messages for ${account.email}, processing directly`);
		const failed: string[] = [];
		for (const id of messageIds) {
			try {
				await processMessageNotification({ type: 'message', accountId: account.id, messageId: id }, env, waitUntil);
			} catch (err) {
				console.error(`Direct processing failed for message ${id}:`, err);
				failed.push(id);
			}
		}
		// 失败的入队重试
		if (failed.length > 0) {
			console.log(`Enqueueing ${failed.length} failed messages for retry`);
			await env.EMAIL_QUEUE.sendBatch(
				failed.map((id) => ({
					body: { type: 'message' as const, accountId: account.id, messageId: id },
				})),
			);
		}
	} else {
		console.log(`Found ${messageIds.length} new messages for ${account.email}, enqueueing`);
		await env.EMAIL_QUEUE.sendBatch(
			messageIds.map((id) => ({
				body: { type: 'message' as const, accountId: account.id, messageId: id },
			})),
		);
	}
}

/** 按账号消费消息 + 幂等防重 */
export async function processMessageNotification(
	msg: Extract<QueueMessage, { type: 'message' }>,
	env: Env,
	waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
	const dedupeKey = `${KV_PROCESSED_PREFIX}${msg.messageId}`;
	const processed = await env.EMAIL_KV.get(dedupeKey);
	if (processed) {
		console.log(`跳过重复消息: ${msg.messageId}`);
		return;
	}

	const account = await getAccountById(env.DB, msg.accountId);
	if (!account) {
		console.log(`Account ${msg.accountId} not found, skipping message ${msg.messageId}`);
		return;
	}

	const token = await getAccessToken(env, account);
	await processGmailMessage(token, msg.messageId, account, env, waitUntil);

	await env.EMAIL_KV.put(dedupeKey, '1', {
		expirationTtl: PROCESSED_TTL_SECONDS,
	});
}

/** 获取单封 Gmail 邮件（raw 格式），解析并发送到账号对应的 Telegram chat */
async function processGmailMessage(
	token: string,
	messageId: string,
	account: Account,
	env: Env,
	waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
	const tgToken = await getTelegramToken(env);
	const chatId = account.chat_id;

	const msg = await gmailGet(token, `/users/me/messages/${messageId}?format=raw`);
	const rawEmail = base64urlToArrayBuffer(msg.raw);
	const parser = new PostalMime();
	const email = await parser.parse(rawEmail);

	const subject = email.subject || '无主题';
	const recipient = account.email || `Account #${account.id}`;
	const header = buildTelegramHeader(email.from?.name || '', email.from?.address || '未知', recipient, subject);
	const hasAttachments = !!(email.attachments && email.attachments.length > 0);
	const charLimit = hasAttachments ? TG_CAPTION_LIMIT : TG_MSG_LIMIT;

	const llmUrl = env.LLM_API_URL;
	const llmKey = env.LLM_API_KEY;
	const llmModel = env.LLM_MODEL;
	const shouldSummarize = !!(llmUrl && llmKey && llmModel);

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

	// 发送后调用 LLM 生成摘要，仅处理文字正文
	const rawBody = email.text || '';
	if (!rawBody.trim()) return;

	// 用 waitUntil 异步执行，不阻塞队列 ack
	waitUntil(
		(async () => {
			try {
				const summary = await summarizeEmail(llmUrl, llmKey, llmModel, subject, rawBody);

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
				throw err;
			}
		})(),
	);
}

function buildTelegramHeader(fromName: string, fromAddress: string, recipient: string, subject: string): string {
	const date = new Date().toLocaleString(MESSAGE_DATE_LOCALE, { timeZone: MESSAGE_DATE_TIMEZONE });
	return [
		`*发件人:*  ${escapeMdV2(`${fromName} <${fromAddress}>`)}`,
		`*收件人:*  ${escapeMdV2(recipient)}`,
		`*时  间:*  ${escapeMdV2(date)}`,
		`*主  题:*  ${escapeMdV2(subject)}`,
		``,
		``,
	].join('\n');
}
