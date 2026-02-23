import PostalMime from 'postal-mime';

export interface Env {
	TG_TOKEN: string;
	CHAT_ID: string;
}

export default {
	async email(message: any, env: Env, ctx: ExecutionContext) {
		const { TG_TOKEN, CHAT_ID } = env;

		try {
			// 1. 将原始邮件流转为 ArrayBuffer (postal-mime 需要这个格式)
			const rawEmail = await new Response(message.raw).arrayBuffer();

			// 2. 使用库解析邮件
			const parser = new PostalMime();
			const email = await parser.parse(rawEmail);

			// 3. 提取元数据
			const from = email.from?.address || message.from;
			const fromName = email.from?.name || '';
			const subject = email.subject || '无主题';
			const date = new Date().toLocaleString('zh-CN', { timeZone: 'America/New_York' });

			// 4. 构造消息，有附件时用 caption (1024)，否则用 sendMessage (4096)
			const hasAttachments = email.attachments && email.attachments.length > 0;
			const charLimit = hasAttachments ? TG_CAPTION_LIMIT : TG_MSG_LIMIT;

			const header = [
				`<b>发件人:</b>  ${escapeHtml(fromName)} &lt;${escapeHtml(from)}&gt;`,
				`<b>时  间:</b>  ${escapeHtml(date)}`,
				`<b>主  题:</b>  ${escapeHtml(subject)}`,
				``,
				``,
			].join('\n');

			// 计算 body 可用预算（留 40 字符余量给截断提示等）
			const overhead = header.length + 40;
			const bodyBudget = Math.max(charLimit - overhead, 100);

			const body = formatBody(email.text, email.html, bodyBudget);
			const text = header + body;

			// 5. 发送到 Telegram
			if (hasAttachments) {
				await sendWithAttachments(TG_TOKEN, CHAT_ID, text, email.attachments!);
			} else {
				await sendTextMessage(TG_TOKEN, CHAT_ID, text);
			}
		} catch (e: any) {
			console.error('Worker 运行异常:', e.message);
		}
	},
};

function escapeHtml(str: string): string {
	if (!str) return '';
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** Telegram sendMessage 字符上限 */
const TG_MSG_LIMIT = 4096;
/** Telegram caption 字符上限 (sendDocument / sendMediaGroup) */
const TG_CAPTION_LIMIT = 1024;

/**
 * 处理邮件正文：优先纯文本，fallback 到 HTML 去标签，超长截断并提示。
 * @param maxLen 本次可用的最大字符数（由调用方根据其他部分占用动态计算）
 */
function formatBody(text: string | undefined, html: string | undefined, maxLen: number): string {
	let raw = text?.trim() ?? '';

	if (!raw && html) {
		// 去除 HTML 标签，保留文字
		raw = html
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/(p|div|li|tr)>/gi, '\n')
			.replace(/<[^>]*>/g, '')
			.replace(/&nbsp;/g, ' ')
			.trim();
	}

	if (!raw) return '（正文为空）';

	const truncated = raw.length > maxLen;
	const body = raw.substring(0, maxLen);

	let result = escapeHtml(body);
	if (truncated) {
		result += '\n\n<i>… 正文过长，已截断 …</i>';
	}

	return result;
}

/** 发送纯文字消息 */
async function sendTextMessage(token: string, chatId: string, text: string): Promise<void> {
	const url = `https://api.telegram.org/bot${token}/sendMessage`;
	const resp = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
	});
	if (!resp.ok) {
		const err = (await resp.json()) as any;
		console.error('TG sendMessage Error:', err.description);
	}
}

type Attachment = { filename?: string | null; mimeType?: string | null; content: string | ArrayBuffer };

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
async function sendWithAttachments(token: string, chatId: string, caption: string, attachments: Attachment[]): Promise<void> {
	try {
		if (attachments.length === 1) {
			// 单附件：sendDocument
			const att = attachments[0];
			const blob = attToBlob(att);
			const form = new FormData();
			form.append('chat_id', chatId);
			form.append('document', blob, att.filename || 'attachment');
			form.append('caption', caption);
			form.append('parse_mode', 'HTML');

			const url = `https://api.telegram.org/bot${token}/sendDocument`;
			const resp = await fetch(url, { method: 'POST', body: form });
			if (!resp.ok) {
				const err = (await resp.json()) as any;
				console.error('TG sendDocument Error:', err.description);
			}
		} else {
			// 多附件：sendMediaGroup
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
				// caption 只放第一个文件上
				if (i === 0) {
					entry.caption = caption;
					entry.parse_mode = 'HTML';
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
