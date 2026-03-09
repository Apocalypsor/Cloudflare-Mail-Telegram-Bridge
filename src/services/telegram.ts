import { TG_CAPTION_LIMIT, TG_MEDIA_GROUP_LIMIT, TG_MSG_LIMIT } from '../constants';
import type { Attachment } from '../types';

export { TG_CAPTION_LIMIT, TG_MSG_LIMIT };

function isEntityParseError(description: string | undefined): boolean {
	return !!description && /can't parse entities/i.test(description);
}

function markdownV2ToPlainText(text: string): string {
	let out = text;
	out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2');
	out = out.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1');
	return out;
}

function extractTelegramDescription(payload: unknown): string {
	if (!payload || typeof payload !== 'object' || !('description' in payload)) return 'Unknown Telegram error';
	const desc = (payload as { description?: unknown }).description;
	return typeof desc === 'string' ? desc : 'Unknown Telegram error';
}

/** 发送纯文本消息（不使用 parse_mode），返回 message_id */
export async function sendPlainTextMessage(token: string, chatId: string, text: string, replyMarkup?: unknown): Promise<number> {
	const url = `https://api.telegram.org/bot${token}/sendMessage`;
	const body: Record<string, unknown> = { chat_id: chatId, text };
	if (replyMarkup) body.reply_markup = replyMarkup;
	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const data = (await resp.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
	if (!resp.ok) {
		throw new Error(`TG sendMessage plain ${resp.status}: ${data.description || 'Unknown error'}`);
	}
	return data.result!.message_id;
}

/** 发送纯文字消息，返回 message_id */
export async function sendTextMessage(token: string, chatId: string, text: string): Promise<number> {
	const url = `https://api.telegram.org/bot${token}/sendMessage`;
	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'MarkdownV2' }),
	});
	if (!resp.ok) {
		const err = (await resp.json()) as unknown;
		const errDescription = extractTelegramDescription(err);
		console.error('TG sendMessage failed payload:', {
			chatId,
			textLength: text.length,
			description: errDescription,
		});
		if (isEntityParseError(errDescription)) {
			const plain = markdownV2ToPlainText(text);
			console.warn('TG sendMessage parse_mode failed, retrying as plain text');
			return sendPlainTextMessage(token, chatId, plain);
		}
		throw new Error(`TG sendMessage ${resp.status}: ${errDescription}`);
	}
	const data = (await resp.json()) as { result: { message_id: number } };
	return data.result.message_id;
}

/** 编辑已发送的文字消息 */
export async function editTextMessage(
	token: string,
	chatId: string,
	messageId: number,
	text: string,
	replyMarkup?: unknown,
): Promise<void> {
	const url = `https://api.telegram.org/bot${token}/editMessageText`;
	const payload: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text, parse_mode: 'MarkdownV2' };
	if (replyMarkup) payload.reply_markup = replyMarkup;
	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	if (!resp.ok) {
		const err = (await resp.json()) as unknown;
		const errDescription = extractTelegramDescription(err);
		if (isEntityParseError(errDescription)) {
			console.warn('TG editMessageText parse_mode failed, retrying as plain text');
			const plain = markdownV2ToPlainText(text);
			const fallbackPayload: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text: plain };
			if (replyMarkup) fallbackPayload.reply_markup = replyMarkup;
			const fallbackResp = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(fallbackPayload),
			});
			if (fallbackResp.ok) return;
			const fallbackErr = (await fallbackResp.json()) as unknown;
			throw new Error(`TG editMessageText fallback ${fallbackResp.status}: ${extractTelegramDescription(fallbackErr)}`);
		}
		throw new Error(`TG editMessageText ${resp.status}: ${errDescription}`);
	}
}

/** 发送文字消息并附带 reply_markup，返回 message_id */
async function sendTextMessageWithMarkup(token: string, chatId: string, text: string, replyMarkup?: unknown): Promise<number> {
	const url = `https://api.telegram.org/bot${token}/sendMessage`;
	const payload: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'MarkdownV2' };
	if (replyMarkup) payload.reply_markup = replyMarkup;
	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	if (!resp.ok) {
		const err = (await resp.json()) as unknown;
		const errDescription = extractTelegramDescription(err);
		if (isEntityParseError(errDescription)) {
			console.warn('TG sendMessage parse_mode failed, retrying as plain text');
			const plain = markdownV2ToPlainText(text);
			const fallbackPayload: Record<string, unknown> = { chat_id: chatId, text: plain };
			if (replyMarkup) fallbackPayload.reply_markup = replyMarkup;
			const fallbackResp = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(fallbackPayload),
			});
			if (!fallbackResp.ok) {
				const fallbackErr = (await fallbackResp.json()) as unknown;
				throw new Error(`TG sendMessage fallback ${(fallbackResp).status}: ${extractTelegramDescription(fallbackErr)}`);
			}
			const fallbackData = (await fallbackResp.json()) as { result: { message_id: number } };
			return fallbackData.result.message_id;
		}
		throw new Error(`TG sendMessage ${resp.status}: ${errDescription}`);
	}
	const data = (await resp.json()) as { result: { message_id: number } };
	return data.result.message_id;
}

function attToBlob(att: Attachment): Blob {
	const mime = att.mimeType || 'application/octet-stream';
	return typeof att.content === 'string'
		? new Blob([new TextEncoder().encode(att.content)], { type: mime })
		: new Blob([att.content], { type: mime });
}

/**
 * 发送消息 + 附件，返回文字消息的 message_id。
 * - 1 个附件: sendDocument + caption + reply_markup
 * - 多个附件: 先发文字消息（带 reply_markup），再发媒体组作为回复
 * - 超过 10 个附件: 分批发送，每批最多 10 个
 */
export async function sendWithAttachments(token: string, chatId: string, caption: string, attachments: Attachment[], replyMarkup?: unknown): Promise<number> {
	try {
		if (attachments.length === 1) {
			const att = attachments[0];
			const blob = attToBlob(att);
			const form = new FormData();
			form.append('chat_id', chatId);
			form.append('document', blob, att.filename || 'attachment');
			form.append('caption', caption);
			form.append('parse_mode', 'MarkdownV2');
			if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));

			const url = `https://api.telegram.org/bot${token}/sendDocument`;
			const resp = await fetch(url, { method: 'POST', body: form });
			if (!resp.ok) {
				const err = (await resp.json()) as any;
				console.error('TG sendDocument failed payload:', {
					chatId,
					captionLength: caption.length,
					filename: att.filename || 'attachment',
					description: err?.description,
				});
				if (isEntityParseError(err?.description)) {
					console.warn('TG sendDocument parse_mode failed, retrying as plain caption');
					const fallbackForm = new FormData();
					fallbackForm.append('chat_id', chatId);
					fallbackForm.append('document', blob, att.filename || 'attachment');
					fallbackForm.append('caption', markdownV2ToPlainText(caption));
					if (replyMarkup) fallbackForm.append('reply_markup', JSON.stringify(replyMarkup));
					const fallbackResp = await fetch(url, { method: 'POST', body: fallbackForm });
					if (!fallbackResp.ok) {
						const fallbackErr = (await fallbackResp.json()) as any;
						throw new Error(`TG sendDocument fallback ${fallbackResp.status}: ${fallbackErr.description}`);
					}
					const fallbackData = (await fallbackResp.json()) as { result: { message_id: number } };
					return fallbackData.result.message_id;
				}
				throw new Error(`TG sendDocument ${resp.status}: ${err.description}`);
			}
			const data = (await resp.json()) as { result: { message_id: number } };
			return data.result.message_id;
		} else {
			// 多附件：先发文字消息（带键盘），再发媒体组作为回复（无 caption）
			// 这样文字消息有完整 inline keyboard，附件也不会被 caption 拆开
			const textMsgId = await sendTextMessageWithMarkup(token, chatId, caption, replyMarkup);

			const chunks: Attachment[][] = [];
			for (let i = 0; i < attachments.length; i += TG_MEDIA_GROUP_LIMIT) {
				chunks.push(attachments.slice(i, i + TG_MEDIA_GROUP_LIMIT));
			}
			for (const chunk of chunks) {
				await sendMediaGroupChunk(token, chatId, '', chunk, textMsgId);
			}
			return textMsgId;
		}
	} catch (e: any) {
		throw new Error(`发送附件消息异常: ${e.message}`);
	}
}

/** 编辑附件消息的 caption */
export async function editMessageCaption(
	token: string,
	chatId: string,
	messageId: number,
	caption: string,
	replyMarkup?: unknown,
): Promise<void> {
	const url = `https://api.telegram.org/bot${token}/editMessageCaption`;
	const payload: Record<string, unknown> = { chat_id: chatId, message_id: messageId, caption, parse_mode: 'MarkdownV2' };
	if (replyMarkup) payload.reply_markup = replyMarkup;
	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	if (!resp.ok) {
		const err = (await resp.json()) as unknown;
		const errDescription = extractTelegramDescription(err);
		if (isEntityParseError(errDescription)) {
			console.warn('TG editMessageCaption parse_mode failed, retrying as plain text');
			const plain = markdownV2ToPlainText(caption);
			const fallbackPayload: Record<string, unknown> = { chat_id: chatId, message_id: messageId, caption: plain };
			if (replyMarkup) fallbackPayload.reply_markup = replyMarkup;
			const fallbackResp = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(fallbackPayload),
			});
			if (fallbackResp.ok) return;
			const fallbackErr = (await fallbackResp.json()) as unknown;
			throw new Error(`TG editMessageCaption fallback ${fallbackResp.status}: ${extractTelegramDescription(fallbackErr)}`);
		}
		throw new Error(`TG editMessageCaption ${resp.status}: ${errDescription}`);
	}
}

/** 设置/更新消息的 inline keyboard */
export async function setReplyMarkup(token: string, chatId: string, messageId: number, replyMarkup: unknown): Promise<void> {
	const url = `https://api.telegram.org/bot${token}/editMessageReplyMarkup`;
	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
	});
	if (!resp.ok) {
		const err = (await resp.json()) as any;
		console.error(`TG editMessageReplyMarkup failed: ${err?.description}`);
	}
}

async function sendMediaGroupChunk(token: string, chatId: string, caption: string, attachments: Attachment[], replyToMessageId?: number): Promise<number> {
	const form = new FormData();
	form.append('chat_id', chatId);
	if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));

	const media = attachments.map((att, i) => {
		const fieldName = `file${i}`;
		const blob = attToBlob(att);
		form.append(fieldName, blob, att.filename || `attachment_${i + 1}`);

		const entry: Record<string, string> = {
			type: 'document',
			media: `attach://${fieldName}`,
		};
		if (i === 0 && caption) {
			entry.caption = caption;
			entry.parse_mode = 'MarkdownV2';
		}
		return entry;
	});

	form.append('media', JSON.stringify(media));

	const url = `https://api.telegram.org/bot${token}/sendMediaGroup`;
	const resp = await fetch(url, { method: 'POST', body: form });
	if (!resp.ok) {
		const err = (await resp.json()) as any;
		console.error('TG sendMediaGroup failed payload:', {
			chatId,
			captionLength: caption.length,
			attachments: attachments.length,
			description: err?.description,
		});
		if (isEntityParseError(err?.description) && caption) {
			console.warn('TG sendMediaGroup parse_mode failed, retrying as plain caption');
			const fallbackForm = new FormData();
			fallbackForm.append('chat_id', chatId);
			const fallbackMedia = attachments.map((att, i) => {
				const fieldName = `file${i}`;
				const blob = attToBlob(att);
				fallbackForm.append(fieldName, blob, att.filename || `attachment_${i + 1}`);
				const entry: Record<string, string> = {
					type: 'document',
					media: `attach://${fieldName}`,
				};
				if (i === 0) {
					entry.caption = markdownV2ToPlainText(caption);
				}
				return entry;
			});
			fallbackForm.append('media', JSON.stringify(fallbackMedia));
			const fallbackResp = await fetch(url, { method: 'POST', body: fallbackForm });
			if (!fallbackResp.ok) {
				const fallbackErr = (await fallbackResp.json()) as any;
				throw new Error(`TG sendMediaGroup fallback ${fallbackResp.status}: ${fallbackErr.description}`);
			}
			const fallbackData = (await fallbackResp.json()) as { result: Array<{ message_id: number }> };
			return fallbackData.result[0].message_id;
		}
		throw new Error(`TG sendMediaGroup ${resp.status}: ${err.description}`);
	}
	const data = (await resp.json()) as { result: Array<{ message_id: number }> };
	return data.result[0].message_id;
}
