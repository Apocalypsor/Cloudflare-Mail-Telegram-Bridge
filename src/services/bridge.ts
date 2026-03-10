import PostalMime from 'postal-mime';
import { STAR_KEYBOARD, starKeyboardWithMailUrl, STARRED_KEYBOARD, starredKeyboardWithMailUrl } from '../bot';
import {
	DIRECT_PROCESS_THRESHOLD,
	KV_PROCESSED_PREFIX,
	MESSAGE_DATE_LOCALE,
	MESSAGE_DATE_TIMEZONE,
	PROCESSED_TTL_SECONDS,
} from '../constants';
import { getAccountByEmail, getAccountById } from '../db/accounts';
import { deleteFailedEmail, getAllFailedEmails, putFailedEmail, type FailedEmail } from '../db/failed-emails';
import { getHistoryId, putHistoryId } from '../db/kv';
import { getMessageMapping, putMessageMapping } from '../db/message-map';
import type { Account, Env, GmailNotification, PubSubPushBody, QueueMessage } from '../types';
import { base64urlToArrayBuffer } from '../utils/base64url';
import { formatBody, htmlToMarkdown, toTelegramMdV2 } from '../utils/format';
import { generateMailToken } from '../utils/hash';
import { escapeMdV2 } from '../utils/markdown-v2';
import { fetchNewMessageIds, getAccessToken, gmailGet } from './gmail';
import { extractLinks, extractVerificationCode, generateTags, summarizeEmail } from './llm';
import { reportErrorToObservability } from './observability';
import {
	editMessageCaption,
	editTextMessage,
	sendTextMessage,
	sendWithAttachments,
	setReplyMarkup,
	TG_CAPTION_LIMIT,
	TG_MSG_LIMIT,
} from './telegram';

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

// ---------------------------------------------------------------------------
// 共享 helper
// ---------------------------------------------------------------------------

/** 从邮件中提取正文文本，text/plain 优先，fallback 到 HTML → Markdown */
function getEmailPlainBody(email: { text?: string; html?: string }): string {
	if (email.text?.trim()) return email.text;
	if (email.html) {
		try {
			return htmlToMarkdown(email.html);
		} catch {
			return '';
		}
	}
	return '';
}

/** 根据消息映射和环境构建编辑用键盘 */
async function resolveEditKeyboard(env: Env, chatId: string, tgMessageId: number, gmailMessageId: string): Promise<unknown> {
	const mapping = await getMessageMapping(env.DB, chatId, tgMessageId);
	const starred = !!mapping?.starred;
	if (env.WORKER_URL) {
		const mailToken = await generateMailToken(env.ADMIN_SECRET, gmailMessageId, chatId);
		const mailUrl = `${env.WORKER_URL.replace(/\/$/, '')}/mail/${gmailMessageId}?t=${mailToken}`;
		return starred ? starredKeyboardWithMailUrl(mailUrl) : starKeyboardWithMailUrl(mailUrl);
	}
	return starred ? STARRED_KEYBOARD : STAR_KEYBOARD;
}

interface LlmEditContext {
	env: Env;
	tgToken: string;
	chatId: string;
	tgMessageId: number;
	isCaption: boolean;
	header: string;
	subject: string;
	plainBody: string;
	/** 用于验证码场景：编辑后保留可展开引用正文 */
	formattedBody?: string;
	keyboard: unknown;
}

/** 核心 LLM 处理：提取验证码 → 生成摘要 + 标签 → 编辑 Telegram 消息 */
async function runLlmProcessing(ctx: LlmEditContext): Promise<void> {
	const { env } = ctx;
	const llmUrl = env.LLM_API_URL!;
	const llmKey = env.LLM_API_KEY!;
	const llmModel = env.LLM_MODEL!;

	const editMessage = (newText: string) =>
		ctx.isCaption
			? editMessageCaption(ctx.tgToken, ctx.chatId, ctx.tgMessageId, newText, ctx.keyboard)
			: editTextMessage(ctx.tgToken, ctx.chatId, ctx.tgMessageId, newText, ctx.keyboard);

	// 第一步：尝试用 LLM 提取验证码
	const verifyCode = await extractVerificationCode(llmUrl, llmKey, llmModel, ctx.subject, ctx.plainBody).catch((err) => {
		reportErrorToObservability(env, 'llm.verify_code_failed', err, { subject: ctx.subject });
		return null;
	});

	if (verifyCode && ctx.formattedBody) {
		const codeSection = `*🔒 验证码:*  \`${escapeMdV2(verifyCode)}\`\n\n`;
		await editMessage(ctx.header + codeSection + wrapExpandableQuote(ctx.formattedBody));
		console.log(`Verification code extracted: ${verifyCode}`);
		return;
	}

	// 第二步：无验证码 → 生成摘要 + 标签
	const links = extractLinks(ctx.plainBody);
	const [summary, tags] = await Promise.all([
		summarizeEmail(llmUrl, llmKey, llmModel, ctx.subject, ctx.plainBody, links),
		generateTags(llmUrl, llmKey, llmModel, ctx.subject, ctx.plainBody).catch((err) => {
			reportErrorToObservability(env, 'llm.tags_failed', err, { subject: ctx.subject });
			return [] as string[];
		}),
	]);

	const tagsLine = tags.length > 0 ? `\n\n${tags.map((t) => `\\#${escapeMdV2(t.replace(/\s+/g, '_'))}`).join('  ')}` : '';
	const summarySection = `*${escapeMdV2('🤖 AI 摘要')}*\n\n${toTelegramMdV2(summary)}`;
	await editMessage(ctx.header + summarySection + tagsLine);
}

// ---------------------------------------------------------------------------
// 邮件处理
// ---------------------------------------------------------------------------

/** 获取单封 Gmail 邮件（raw 格式），解析并发送到账号对应的 Telegram chat */
async function processGmailMessage(
	token: string,
	messageId: string,
	account: Account,
	env: Env,
	waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
	const tgToken = env.TELEGRAM_BOT_TOKEN;
	const chatId = account.chat_id;

	const msg = await gmailGet(token, `/users/me/messages/${messageId}?format=raw`);
	const rawEmail = base64urlToArrayBuffer(msg.raw);
	const parser = new PostalMime();
	const email = await parser.parse(rawEmail);

	const subject = email.subject || '无主题';
	const recipient = account.email || `Account #${account.id}`;
	const header = buildTelegramHeader(email.from?.name || '', email.from?.address || '未知', recipient, subject);
	const hasAttachments = !!(email.attachments && email.attachments.length > 0);
	const hasSingleAttachment = hasAttachments && email.attachments!.length === 1;
	// 单附件用 sendDocument caption（1024 字符限制），其他用 sendMessage（4096 字符限制）
	const charLimit = hasSingleAttachment ? TG_CAPTION_LIMIT : TG_MSG_LIMIT;

	const llmUrl = env.LLM_API_URL;
	const llmKey = env.LLM_API_KEY;
	const llmModel = env.LLM_MODEL;
	const hasLlm = !!(llmUrl && llmKey && llmModel);

	// 初始消息不含验证码（由 LLM 异步提取）
	const bodyBudget = Math.max(Math.floor((charLimit - header.length) * 0.9), 100);
	const formattedBody = formatBody(email.text, email.html, bodyBudget);
	const text = header + wrapExpandableQuote(formattedBody);

	// 生成查看原文链接并构建键盘
	let keyboard: unknown = STAR_KEYBOARD;
	let mailUrl: string | undefined;
	if (env.WORKER_URL) {
		const mailToken = await generateMailToken(env.ADMIN_SECRET, messageId, chatId);
		mailUrl = `${env.WORKER_URL.replace(/\/$/, '')}/mail/${messageId}?t=${mailToken}`;
		keyboard = starKeyboardWithMailUrl(mailUrl);
	}

	// 发送原始消息
	let sentMessageId: number;
	if (hasAttachments) {
		sentMessageId = await sendWithAttachments(tgToken, chatId, text, email.attachments || [], keyboard);
	} else {
		sentMessageId = await sendTextMessage(tgToken, chatId, text);
		await setReplyMarkup(tgToken, chatId, sentMessageId, keyboard);
	}

	// 保存 Telegram ↔ Gmail 消息映射（用于 reaction 已读/星标）
	await putMessageMapping(env.DB, {
		tg_message_id: sentMessageId,
		tg_chat_id: chatId,
		gmail_message_id: messageId,
		account_id: account.id,
	});

	if (!hasLlm) return;

	const plainBody = getEmailPlainBody(email);
	if (!plainBody.trim()) return;

	// 用 waitUntil 异步执行 LLM：先提取验证码，找到则显示验证码，否则生成摘要
	waitUntil(
		(async () => {
			try {
				const editKeyboard = await resolveEditKeyboard(env, chatId, sentMessageId, messageId);
				await runLlmProcessing({
					env,
					tgToken,
					chatId,
					tgMessageId: sentMessageId,
					isCaption: hasSingleAttachment,
					header,
					subject,
					plainBody,
					formattedBody,
					keyboard: editKeyboard,
				});
			} catch (err) {
				await reportErrorToObservability(env, 'llm.summary_failed', err, { subject });
				await putFailedEmail(env.DB, {
					account_id: account.id,
					gmail_message_id: messageId,
					tg_chat_id: chatId,
					tg_message_id: sentMessageId,
					is_caption: hasSingleAttachment ? 1 : 0,
					subject,
					error_message: err instanceof Error ? err.message : String(err),
				}).catch((e) => console.error('Failed to save failed email record:', e));
			}
		})(),
	);
}

/** 将文本包裹为 Telegram 可展开引用块（expandable blockquote） */
function wrapExpandableQuote(text: string): string {
	if (!text) return '';
	// 去掉代码块围栏，对原代码块内容做 MdV2 转义
	let inCode = false;
	const processed: string[] = [];
	for (const line of text.split('\n')) {
		if (/^```/.test(line)) {
			inCode = !inCode;
			continue;
		}
		let out = inCode ? escapeMdV2(line) : line;
		if (out.startsWith('>')) out = `\\${out}`;
		processed.push(out);
	}
	return processed.map((line, i) => (i === 0 ? `**>${line}` : `>${line}`)).join('\n') + '||';
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

// ---------------------------------------------------------------------------
// 失败邮件重试
// ---------------------------------------------------------------------------

/** 重试单封失败邮件的 LLM 摘要处理，成功后自动删除失败记录 */
export async function retryFailedEmail(failed: FailedEmail, env: Env): Promise<void> {
	const account = await getAccountById(env.DB, failed.account_id);
	if (!account) throw new Error(`Account ${failed.account_id} not found`);

	if (!env.LLM_API_URL || !env.LLM_API_KEY || !env.LLM_MODEL) throw new Error('LLM not configured');

	// 重新从 Gmail 获取邮件
	const token = await getAccessToken(env, account);
	const msg = await gmailGet(token, `/users/me/messages/${failed.gmail_message_id}?format=raw`);
	const rawEmail = base64urlToArrayBuffer(msg.raw);
	const parser = new PostalMime();
	const email = await parser.parse(rawEmail);

	const plainBody = getEmailPlainBody(email);
	if (!plainBody.trim()) {
		await deleteFailedEmail(env.DB, failed.id);
		return;
	}

	const subject = email.subject || '无主题';
	const recipient = account.email || `Account #${account.id}`;
	const header = buildTelegramHeader(email.from?.name || '', email.from?.address || '未知', recipient, subject);
	const keyboard = await resolveEditKeyboard(env, failed.tg_chat_id, failed.tg_message_id, failed.gmail_message_id);

	await runLlmProcessing({
		env,
		tgToken: env.TELEGRAM_BOT_TOKEN,
		chatId: failed.tg_chat_id,
		tgMessageId: failed.tg_message_id,
		isCaption: !!failed.is_caption,
		header,
		subject,
		plainBody,
		keyboard,
	});

	await deleteFailedEmail(env.DB, failed.id);
}

/** 重试所有失败邮件，返回 { success, failed } 计数 */
export async function retryAllFailedEmails(env: Env): Promise<{ success: number; failed: number }> {
	const items = await getAllFailedEmails(env.DB);
	let success = 0;
	let failed = 0;
	for (const item of items) {
		try {
			await retryFailedEmail(item, env);
			success++;
		} catch (err) {
			console.error(`Retry failed for id=${item.id}:`, err);
			failed++;
		}
	}
	return { success, failed };
}
