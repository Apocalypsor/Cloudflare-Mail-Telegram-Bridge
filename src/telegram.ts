import type { Attachment } from './types';

/** Telegram sendMessage 字符上限 */
export const TG_MSG_LIMIT = 4096;
/** Telegram caption 字符上限 (sendDocument / sendMediaGroup) */
export const TG_CAPTION_LIMIT = 1024;

/** 发送纯文字消息 */
export async function sendTextMessage(token: string, chatId: string, text: string): Promise<void> {
	const url = `https://api.telegram.org/bot${token}/sendMessage`;
	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'MarkdownV2' }),
	});
	if (!resp.ok) {
		const err = (await resp.json()) as any;
		console.error('TG sendMessage Error:', err.description);
	}
}

function attToBlob(att: Attachment): Blob {
	const mime = att.mimeType || 'application/octet-stream';
	return typeof att.content === 'string'
		? new Blob([new TextEncoder().encode(att.content)], { type: mime })
		: new Blob([att.content], { type: mime });
}

/**
 * 发送消息 + 附件合并在一条 Telegram 消息中。
 * - 1 个附件: sendDocument + caption
 * - 多个附件: sendMediaGroup，caption 放第一个文件上
 */
export async function sendWithAttachments(token: string, chatId: string, caption: string, attachments: Attachment[]): Promise<void> {
	try {
		if (attachments.length === 1) {
			const att = attachments[0];
			const blob = attToBlob(att);
			const form = new FormData();
			form.append('chat_id', chatId);
			form.append('document', blob, att.filename || 'attachment');
			form.append('caption', caption);
			form.append('parse_mode', 'MarkdownV2');

			const url = `https://api.telegram.org/bot${token}/sendDocument`;
			const resp = await fetch(url, { method: 'POST', body: form });
			if (!resp.ok) {
				const err = (await resp.json()) as any;
				console.error('TG sendDocument Error:', err.description);
			}
		} else {
			const form = new FormData();
			form.append('chat_id', chatId);

			const media = attachments.map((att, i) => {
				const fieldName = `file${i}`;
				const blob = attToBlob(att);
				form.append(fieldName, blob, att.filename || `attachment_${i + 1}`);

				const entry: Record<string, string> = {
					type: 'document',
					media: `attach://${fieldName}`,
				};
				if (i === 0) {
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
				console.error('TG sendMediaGroup Error:', err.description);
			}
		}
	} catch (e: any) {
		console.error('发送附件消息异常:', e.message);
	}
}
