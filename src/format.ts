import { NodeHtmlMarkdown } from 'node-html-markdown';
import { convert } from 'telegram-markdown-v2';

/** HTML → Markdown 转换器实例 */
const nhm = new NodeHtmlMarkdown({
	bulletMarker: '•',
	codeBlockStyle: 'fenced',
	emDelimiter: '_',
	strongDelimiter: '**',
});

/**
 * 转义 Telegram MarkdownV2 特殊字符。
 * 参考: https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMdV2(str: string): string {
	if (!str) return '';
	return str.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** 标准 Markdown → Telegram MarkdownV2 */
export function toTelegramMdV2(markdown: string): string {
	if (!markdown) return '';
	return convert(markdown).trimEnd();
}

/**
 * 处理邮件正文：优先将 HTML 转 Markdown，fallback 到纯文本，超长截断并提示。
 * @param maxLen 本次可用的最大字符数（由调用方根据其他部分占用动态计算）
 */
export function formatBody(text: string | undefined, html: string | undefined, maxLen: number): string {
	let raw = '';

	if (html) {
		let cleanHtml = html
			.replace(/<!doctype[^>]*>/gi, '')
			.replace(/<head[\s\S]*?<\/head>/gi, '')
			.replace(/<style[\s\S]*?<\/style>/gi, '')
			.replace(/<script[\s\S]*?<\/script>/gi, '')
			.replace(/<\/(td|th|div|p|li|tr|h[1-6])>/gi, '</$1>\n')
			.replace(/<br\s*\/?>/gi, '\n');

		raw = nhm.translate(cleanHtml).trim();
	}

	if (!raw && text) {
		raw = text.trim();
	}

	if (!raw) return escapeMdV2('（正文为空）');

	// HTML 实体
	raw = raw
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#0?39;/gi, "'");

	// 残留 HTML 标签
	raw = raw.replace(/<[^>]*>/g, '');

	const truncated = raw.length > maxLen;
	const bodyStr = raw.substring(0, maxLen);

	let result = toTelegramMdV2(bodyStr);

	if (truncated) {
		result += `\n\n${toTelegramMdV2('*… 正文过长，已截断 …*')}`;
	}

	return result;
}
