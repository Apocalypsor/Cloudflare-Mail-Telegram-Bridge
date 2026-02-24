import { NodeHtmlMarkdown } from 'node-html-markdown';
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
				`*发件人:*  ${escapeMdV2(`${fromName} <${from}>`)}`,
				`*时  间:*  ${escapeMdV2(date)}`,
				`*主  题:*  ${escapeMdV2(subject)}`,
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

/**
 * 转义 Telegram MarkdownV2 特殊字符。
 * 参考: https://core.telegram.org/bots/api#markdownv2-style
 */
function escapeMdV2(str: string): string {
	if (!str) return '';
	return str.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** 将连续多个空行压缩为最多一个空行 */
function collapseBlankLines(str: string): string {
	return str.replace(/\n{3,}/g, '\n\n');
}

/** HTML → Markdown 转换器实例 */
const nhm = new NodeHtmlMarkdown({
	bulletMarker: '•',
	codeBlockStyle: 'fenced',
	strongDelimiter: '**',
	emDelimiter: '_',
});

/** Telegram sendMessage 字符上限 */
const TG_MSG_LIMIT = 4096;
/** Telegram caption 字符上限 (sendDocument / sendMediaGroup) */
const TG_CAPTION_LIMIT = 1024;

/**
 * 处理邮件正文：优先将 HTML 转 Markdown，fallback 到纯文本，超长截断并提示。
 * @param maxLen 本次可用的最大字符数（由调用方根据其他部分占用动态计算）
 */
function formatBody(text: string | undefined, html: string | undefined, maxLen: number): string {
	let raw = '';

	if (html) {
		// 预处理 HTML：去掉 doctype、head、style、script 等无用内容
		let cleanHtml = html
			.replace(/<!doctype[^>]*>/gi, '')
			.replace(/<head[\s\S]*?<\/head>/gi, '')
			.replace(/<style[\s\S]*?<\/style>/gi, '')
			.replace(/<script[\s\S]*?<\/script>/gi, '')
			// 在主要块级元素前后保证换行，避免表格布局吞掉换行
			.replace(/<\/(td|th|div|p|li|tr|h[1-6])>/gi, '</$1>\n')
			.replace(/<br\s*\/?>/gi, '\n');

		raw = nhm.translate(cleanHtml).trim();
	}

	if (!raw && text) {
		raw = text.trim();
	}

	if (!raw) return escapeMdV2('（正文为空）');

	// 删除 Markdown 图片 ![alt](url)
	raw = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, '');

	// 删除纯空白文字的链接 [  ](url) → 删除（图片套链接的残留）
	raw = raw.replace(/\[\s*\]\([^)]*\)/g, '');

	// 删除超链接，保留链接文字 [text](url) → text
	raw = raw.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

	// 标题 → 提取文字（后面单独加粗，避免被 escapeMdV2 转义掉）
	const headings: Array<{ placeholder: string; text: string }> = [];
	raw = raw.replace(/^#{1,6}\s+(.+)$/gm, (_match, content) => {
		const ph = `__HEADING_${headings.length}__`;
		headings.push({ placeholder: ph, text: content });
		return ph;
	});

	// 水平线 → 删除
	raw = raw.replace(/^[-*_]{3,}\s*$/gm, '');

	// 表格：删除分隔行，管道符替换为空格
	raw = raw.replace(/^\|?[\s-]*:?-+:?[\s-|]*\|?\s*$/gm, '');
	raw = raw.replace(/\|/g, ' ');

	// 引用式链接定义 [ref]: url → 删除
	raw = raw.replace(/^\[[^\]]+\]:\s+.+$/gm, '');

	// HTML 实体 → 字符
	raw = raw
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#0?39;/gi, "'");

	// 清理残留 HTML 标签
	raw = raw.replace(/<[^>]*>/g, '');

	// 将连续空格（同一行内多个空格）压缩为一个
	raw = raw.replace(/[^\S\n]+/g, ' ');

	// 去掉每行首尾空白
	raw = raw.replace(/^ +| +$/gm, '');

	// 压缩多余空行
	raw = collapseBlankLines(raw);

	const truncated = raw.length > maxLen;
	const body = raw.substring(0, maxLen);

	// 对正文进行 MarkdownV2 转义
	let result = escapeMdV2(body);

	// 恢复标题为加粗（在转义之后处理，这样 ** 不会被转义）
	for (const h of headings) {
		result = result.replace(escapeMdV2(h.placeholder), `*${escapeMdV2(h.text)}*`);
	}

	if (truncated) {
		result += '\n\n_… 正文过长，已截断 …_';
	}

	return result;
}

/** 发送纯文字消息 */
async function sendTextMessage(token: string, chatId: string, text: string): Promise<void> {
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
			form.append('parse_mode', 'MarkdownV2');

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
