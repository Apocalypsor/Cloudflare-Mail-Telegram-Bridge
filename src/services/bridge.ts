import PostalMime from 'postal-mime';
import { MESSAGE_DATE_LOCALE, MESSAGE_DATE_TIMEZONE } from '@/constants';
import { getAccountById } from '@db/accounts';
import { deleteFailedEmail, getAllFailedEmails, putFailedEmail, type FailedEmail } from '@db/failed-emails';
import { deleteMappingByEmailId, putMessageMapping } from '@db/message-map';
import { AccountType, type Account, type Env, type QueueMessage } from '@/types';
import { base64ToArrayBuffer, base64urlToArrayBuffer } from '@utils/base64url';
import { formatBody, htmlToMarkdown, toTelegramMdV2 } from '@utils/format';
import { escapeMdV2 } from '@utils/markdown-v2';
import { getAccessToken, gmailGet } from '@services/email/gmail';
import { fetchImapRawEmail } from '@services/email/imap';
import { fetchRawMime, getAccessToken as msGetAccessToken } from '@services/email/outlook';
import { getEmailProvider } from '@services/email/provider';
import { buildEmailKeyboard, resolveStarredKeyboard } from '@bot/keyboards';
import { analyzeEmail } from '@services/llm';
import { reportErrorToObservability } from '@utils/observability';
import {
	deleteMessage,
	editMessageCaption,
	editTextMessage,
	sendTextMessage,
	sendWithAttachments,
	TG_CAPTION_LIMIT,
	TG_MSG_LIMIT,
} from '@services/telegram';

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

/** 将文本包裹为 Telegram 可展开引用块（expandable blockquote） */
export function wrapExpandableQuote(text: string): string {
	if (!text) return '';
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

function buildTelegramHeader(fromName: string, fromAddress: string, recipient: string, subject: string, accountEmail?: string): string {
	const date = new Date().toLocaleString(MESSAGE_DATE_LOCALE, { timeZone: MESSAGE_DATE_TIMEZONE });
	const lines = [`*发件人:*  ${escapeMdV2(`${fromName} <${fromAddress}>`)}`, `*收件人:*  ${escapeMdV2(recipient)}`];
	if (accountEmail && accountEmail.toLowerCase() !== recipient.toLowerCase()) {
		lines.push(`*账  号:*  ${escapeMdV2(accountEmail)}`);
	}
	lines.push(`*时  间:*  ${escapeMdV2(date)}`, `*主  题:*  ${escapeMdV2(subject)}`, ``, ``);
	return lines.join('\n');
}

/** 从解析后的邮件中提取 TG 消息所需的各项内容 */
function prepareEmailContent(
	email: { subject?: string; to?: { address?: string }[]; from?: { name?: string; address?: string }; text?: string; html?: string },
	account: Account,
	isCaption: boolean,
) {
	const subject = email.subject || '无主题';
	const recipient = email.to?.map((t) => t.address).join(', ') || account.email || `Account #${account.id}`;
	const header = buildTelegramHeader(email.from?.name || '', email.from?.address || '未知', recipient, subject, account.email ?? undefined);
	const charLimit = isCaption ? TG_CAPTION_LIMIT : TG_MSG_LIMIT;
	const bodyBudget = Math.max(Math.floor((charLimit - header.length) * 0.9), 100);
	const formattedBody = formatBody(email.text, email.html, bodyBudget);
	const plainBody = getEmailPlainBody(email);
	return { subject, header, formattedBody, plainBody };
}

/** 调用 LLM 分析邮件并编辑 Telegram 消息（验证码 / 摘要 + 标签），返回分析结果 */
async function editMessageWithAnalysis(
	env: Env,
	tgToken: string,
	chatId: string,
	tgMessageId: number,
	isCaption: boolean,
	header: string,
	subject: string,
	plainBody: string,
	formattedBody: string,
	keyboard: unknown,
): Promise<boolean> {
	const editMsg = (newText: string) =>
		isCaption
			? editMessageCaption(tgToken, chatId, tgMessageId, newText, keyboard)
			: editTextMessage(tgToken, chatId, tgMessageId, newText, keyboard);

	const result = await analyzeEmail(env.LLM_API_URL!, env.LLM_API_KEY!, env.LLM_MODEL!, subject, plainBody);

	// 置信度 >= 0.8 视为垃圾邮件，由调用方删除消息
	if (result.isJunk && result.junkConfidence >= 0.8) {
		console.log(`Junk email detected (confidence=${result.junkConfidence}), will delete`);
		return true;
	}

	const tagsLine =
		result.tags.length > 0 ? `\n\n${result.tags.map((t: string) => `\\#${escapeMdV2(t.replace(/\s+/g, '_'))}`).join('  ')}` : '';

	if (result.verificationCode && formattedBody) {
		const codeSection = `*🔒 验证码:*  \`${escapeMdV2(result.verificationCode)}\`\n\n`;
		await editMsg(header + codeSection + wrapExpandableQuote(formattedBody) + tagsLine);
		console.log('Verification code extracted');
		return false;
	}

	const summarySection = `*${escapeMdV2('🤖 AI 摘要')}*\n\n${toTelegramMdV2(result.summary)}`;
	await editMsg(header + summarySection + tagsLine);
	return false;
}

/** 按账号类型拉取原始邮件 */
export async function fetchRawEmailByType(
	account: Account,
	messageId: string,
	env: Env,
	imapFolder?: 'inbox' | 'junk',
): Promise<ArrayBuffer> {
	if (account.type === AccountType.Imap) {
		const base64 = await fetchImapRawEmail(env, account.id, messageId, imapFolder);
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

	const hasAttachments = !!(email.attachments && email.attachments.length > 0);
	const hasSingleAttachment = hasAttachments && email.attachments!.length === 1;
	const { subject, header, formattedBody, plainBody } = prepareEmailContent(email, account, hasSingleAttachment);
	const text = header + wrapExpandableQuote(formattedBody);

	const hasLlm = !!(env.LLM_API_URL && env.LLM_API_KEY && env.LLM_MODEL);

	const keyboard = await buildEmailKeyboard(env, messageId, account.id, false);

	let sentMessageId: number;
	if (hasAttachments) {
		sentMessageId = await sendWithAttachments(tgToken, chatId, text, email.attachments || [], keyboard);
	} else {
		sentMessageId = await sendTextMessage(tgToken, chatId, text, keyboard);
	}

	const inserted = await putMessageMapping(env.DB, {
		tg_message_id: sentMessageId,
		tg_chat_id: chatId,
		email_message_id: messageId,
		account_id: account.id,
	});

	// 唯一索引冲突 → 说明另一个并发请求已经投递过，撤回本次重复消息
	if (!inserted) {
		console.log(`Duplicate delivery detected for ${messageId}, deleting duplicate Telegram message`);
		await deleteMessage(tgToken, chatId, sentMessageId).catch(() => {});
		return;
	}

	if (!hasLlm) return;

	if (!plainBody.trim()) return;

	waitUntil(
		(async () => {
			try {
				const editKeyboard = await buildEmailKeyboard(env, messageId, account.id, false);
				const isJunk = await editMessageWithAnalysis(
					env,
					tgToken,
					chatId,
					sentMessageId,
					hasSingleAttachment,
					header,
					subject,
					plainBody,
					formattedBody,
					editKeyboard,
				);
				if (isJunk) {
					const provider = getEmailProvider(account, env);
					await provider.markAsJunk(messageId);
					await deleteMessage(tgToken, chatId, sentMessageId).catch(() => {});
					await deleteMappingByEmailId(env.DB, messageId, account.id).catch((e) =>
						reportErrorToObservability(env, 'bridge.delete_junk_mapping_error', e),
					);
				}
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

/** 按账号类型拉取原始邮件并投递到 Telegram */
export async function processEmailMessage(msg: QueueMessage, env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
	const account = await getAccountById(env.DB, msg.accountId);
	if (!account) {
		console.log(`Account ${msg.accountId} not found, skipping message ${msg.messageId}`);
		return;
	}

	const rawEmail = await fetchRawEmailByType(account, msg.messageId, env);

	await deliverEmailToTelegram(rawEmail, msg.messageId, account, env, waitUntil);
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

	const { subject, header, formattedBody, plainBody } = prepareEmailContent(email, account, !!failed.is_caption);
	if (!plainBody.trim()) {
		await deleteFailedEmail(env.DB, failed.id);
		return;
	}
	const keyboard = await resolveStarredKeyboard(env, failed.tg_chat_id, failed.tg_message_id, failed.email_message_id, account.id);

	const isJunk = await editMessageWithAnalysis(
		env,
		env.TELEGRAM_BOT_TOKEN,
		failed.tg_chat_id,
		failed.tg_message_id,
		!!failed.is_caption,
		header,
		subject,
		plainBody,
		formattedBody,
		keyboard,
	);

	if (isJunk) {
		// markAsJunk 失败时让异常传播，保留 failed_emails 记录以便下次重试
		const provider = getEmailProvider(account, env);
		await provider.markAsJunk(failed.email_message_id);
		await deleteMessage(env.TELEGRAM_BOT_TOKEN, failed.tg_chat_id, failed.tg_message_id).catch(() => {});
		await deleteMappingByEmailId(env.DB, failed.email_message_id, account.id).catch((e) =>
			reportErrorToObservability(env, 'bridge.delete_junk_mapping_error', e),
		);
	}

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
