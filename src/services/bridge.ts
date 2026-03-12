import PostalMime from 'postal-mime';
import { KV_PROCESSED_PREFIX, MESSAGE_DATE_LOCALE, MESSAGE_DATE_TIMEZONE, PROCESSED_TTL_SECONDS } from '../constants';
import { getAccountById } from '../db/accounts';
import { deleteFailedEmail, getAllFailedEmails, putFailedEmail, type FailedEmail } from '../db/failed-emails';
import { putMessageMapping } from '../db/message-map';
import { AccountType, type Account, type Env, type QueueMessage } from '../types';
import { base64ToArrayBuffer, base64urlToArrayBuffer } from '../utils/base64url';
import { formatBody, htmlToMarkdown } from '../utils/format';
import { escapeMdV2 } from '../utils/markdown-v2';
import { getAccessToken, gmailGet } from './email/gmail';
import { fetchImapRawEmail } from './email/imap/bridge';
import { fetchRawMime, getAccessToken as msGetAccessToken } from './email/outlook';
import { buildEmailKeyboard, resolveStarredKeyboard } from './keyboard';
import { runLlmProcessing, wrapExpandableQuote } from './llm-processing';
import { reportErrorToObservability } from './observability';
import { sendTextMessage, sendWithAttachments, setReplyMarkup, TG_CAPTION_LIMIT, TG_MSG_LIMIT } from './telegram';

// ---------------------------------------------------------------------------
// 私有 helper
// ---------------------------------------------------------------------------

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

function buildTelegramHeader(fromName: string, fromAddress: string, recipient: string, subject: string, accountEmail?: string): string {
	const date = new Date().toLocaleString(MESSAGE_DATE_LOCALE, { timeZone: MESSAGE_DATE_TIMEZONE });
	const lines = [
		`*发件人:*  ${escapeMdV2(`${fromName} <${fromAddress}>`)}`,
		`*收件人:*  ${escapeMdV2(recipient)}`,
	];
	if (accountEmail && accountEmail.toLowerCase() !== recipient.toLowerCase()) {
		lines.push(`*账  号:*  ${escapeMdV2(accountEmail)}`);
	}
	lines.push(
		`*时  间:*  ${escapeMdV2(date)}`,
		`*主  题:*  ${escapeMdV2(subject)}`,
		``,
		``,
	);
	return lines.join('\n');
}

/** 按账号类型拉取原始邮件 */
export async function fetchRawEmailByType(account: Account, messageId: string, env: Env): Promise<ArrayBuffer> {
	if (account.type === AccountType.Imap) {
		const base64 = await fetchImapRawEmail(env, account.id, messageId);
		return base64ToArrayBuffer(base64);
	}
	if (account.type === AccountType.Outlook) {
		const token = await msGetAccessToken(env, account);
		return fetchRawMime(token, messageId);
	}
	// Gmail
	const token = await getAccessToken(env, account);
	const gmailMsg = await gmailGet(token, `/users/me/messages/${messageId}?format=raw`);
	return base64urlToArrayBuffer(gmailMsg.raw);
}

// ---------------------------------------------------------------------------
// 核心投递（Gmail + IMAP + Outlook 共用）
// ---------------------------------------------------------------------------

/** 解析 raw email 并发送到账号对应的 Telegram chat。 */
export async function deliverEmailToTelegram(
	rawEmail: ArrayBuffer,
	messageId: string,
	account: Account,
	env: Env,
	waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
	const tgToken = env.TELEGRAM_BOT_TOKEN;
	const chatId = account.chat_id;

	const parser = new PostalMime();
	const email = await parser.parse(rawEmail);

	const subject = email.subject || '无主题';
	const recipient = email.to?.map((t) => t.address).join(', ') || account.email || `Account #${account.id}`;
	const header = buildTelegramHeader(email.from?.name || '', email.from?.address || '未知', recipient, subject, account.email ?? undefined);
	const hasAttachments = !!(email.attachments && email.attachments.length > 0);
	const hasSingleAttachment = hasAttachments && email.attachments!.length === 1;
	const charLimit = hasSingleAttachment ? TG_CAPTION_LIMIT : TG_MSG_LIMIT;

	const hasLlm = !!(env.LLM_API_URL && env.LLM_API_KEY && env.LLM_MODEL);

	const bodyBudget = Math.max(Math.floor((charLimit - header.length) * 0.9), 100);
	const formattedBody = formatBody(email.text, email.html, bodyBudget);
	const text = header + wrapExpandableQuote(formattedBody);

	const keyboard = await buildEmailKeyboard(env, messageId, account.email, chatId, false);

	let sentMessageId: number;
	if (hasAttachments) {
		sentMessageId = await sendWithAttachments(tgToken, chatId, text, email.attachments || [], keyboard);
	} else {
		sentMessageId = await sendTextMessage(tgToken, chatId, text);
		await setReplyMarkup(tgToken, chatId, sentMessageId, keyboard);
	}

	await putMessageMapping(env.DB, {
		tg_message_id: sentMessageId,
		tg_chat_id: chatId,
		email_message_id: messageId,
		account_id: account.id,
	});

	if (!hasLlm) return;

	const plainBody = getEmailPlainBody(email);
	if (!plainBody.trim()) return;

	waitUntil(
		(async () => {
			try {
				const editKeyboard = await resolveStarredKeyboard(env, chatId, sentMessageId, messageId, account.email);
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
					email_message_id: messageId,
					tg_chat_id: chatId,
					tg_message_id: sentMessageId,
					is_caption: hasSingleAttachment ? 1 : 0,
					subject,
					error_message: err instanceof Error ? err.message : String(err),
				}).catch((e) => reportErrorToObservability(env, 'bridge.save_failed_email_record_error', e));
			}
		})(),
	);
}

// ---------------------------------------------------------------------------
// 队列消费：统一处理 Gmail + IMAP 邮件消息
// ---------------------------------------------------------------------------

/** 按账号类型拉取原始邮件并投递到 Telegram，支持去重 */
export async function processEmailMessage(msg: QueueMessage, env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
	const dedupeKey = `${KV_PROCESSED_PREFIX}${msg.accountId}:${msg.messageId}`;
	const processed = await env.EMAIL_KV.get(dedupeKey);
	if (processed) {
		console.log(`跳过重复消息: account=${msg.accountId}, messageId=${msg.messageId}`);
		return;
	}

	const account = await getAccountById(env.DB, msg.accountId);
	if (!account) {
		console.log(`Account ${msg.accountId} not found, skipping message ${msg.messageId}`);
		return;
	}

	const rawEmail = await fetchRawEmailByType(account, msg.messageId, env);

	await deliverEmailToTelegram(rawEmail, msg.messageId, account, env, waitUntil);

	await env.EMAIL_KV.put(dedupeKey, '1', { expirationTtl: PROCESSED_TTL_SECONDS });
}

// ---------------------------------------------------------------------------
// 失败邮件重试
// ---------------------------------------------------------------------------

/** 重试单封失败邮件的 LLM 摘要处理，成功后自动删除失败记录 */
export async function retryFailedEmail(failed: FailedEmail, env: Env): Promise<void> {
	const account = await getAccountById(env.DB, failed.account_id);
	if (!account) throw new Error(`Account ${failed.account_id} not found`);

	if (!env.LLM_API_URL || !env.LLM_API_KEY || !env.LLM_MODEL) throw new Error('LLM not configured');

	const rawEmail = await fetchRawEmailByType(account, failed.email_message_id, env);

	const parser = new PostalMime();
	const email = await parser.parse(rawEmail);

	const plainBody = getEmailPlainBody(email);
	if (!plainBody.trim()) {
		await deleteFailedEmail(env.DB, failed.id);
		return;
	}

	const subject = email.subject || '无主题';
	const recipient = email.to?.map((t) => t.address).join(', ') || account.email || `Account #${account.id}`;
	const header = buildTelegramHeader(email.from?.name || '', email.from?.address || '未知', recipient, subject, account.email ?? undefined);
	const charLimit = failed.is_caption ? TG_CAPTION_LIMIT : TG_MSG_LIMIT;
	const bodyBudget = Math.max(Math.floor((charLimit - header.length) * 0.9), 100);
	const formattedBody = formatBody(email.text, email.html, bodyBudget);
	const keyboard = await resolveStarredKeyboard(env, failed.tg_chat_id, failed.tg_message_id, failed.email_message_id, account.email);

	await runLlmProcessing({
		env,
		tgToken: env.TELEGRAM_BOT_TOKEN,
		chatId: failed.tg_chat_id,
		tgMessageId: failed.tg_message_id,
		isCaption: !!failed.is_caption,
		header,
		subject,
		plainBody,
		formattedBody,
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
			await reportErrorToObservability(env, 'bridge.retry_failed', err, { failedEmailId: item.id });
			failed++;
		}
	}
	return { success, failed };
}
