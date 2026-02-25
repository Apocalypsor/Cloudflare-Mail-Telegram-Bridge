import { NodeHtmlMarkdown } from 'node-html-markdown';

/** HTML → Markdown 转换器实例 */
const nhm = new NodeHtmlMarkdown({
	bulletMarker: '•',
	codeBlockStyle: 'fenced',
	strongDelimiter: '**',
	emDelimiter: '_',
});

/**
 * 转义 Telegram MarkdownV2 特殊字符。
 * 参考: https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMdV2(str: string): string {
	if (!str) return '';
	return str.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** 将连续多个空行压缩为最多一个空行 */
function collapseBlankLines(str: string): string {
	return str.replace(/\n{3,}/g, '\n\n');
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

	// 删除 Markdown 图片
	raw = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
	// 删除纯空白链接
	raw = raw.replace(/\[\s*\]\([^)]*\)/g, '');
	// 删除超链接，保留文字
	raw = raw.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

	// 标题 → 占位符
	const headings: Array<{ placeholder: string; text: string }> = [];
	raw = raw.replace(/^#{1,6}\s+(.+)$/gm, (_match, content) => {
		const ph = `__HEADING_${headings.length}__`;
		headings.push({ placeholder: ph, text: content });
		return ph;
	});

	// 水平线
	raw = raw.replace(/^[-*_]{3,}\s*$/gm, '');

	// 表格
	raw = raw.replace(/^\|?[\s-]*:?-+:?[\s-|]*\|?\s*$/gm, '');
	raw = raw.replace(/\|/g, ' ');

	// 引用式链接
	raw = raw.replace(/^\[[^\]]+\]:\s+.+$/gm, '');

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

	// 连续空格压缩
	raw = raw.replace(/[^\S\n]+/g, ' ');
	// 每行首尾空白
	raw = raw.replace(/^ +| +$/gm, '');
	// 多余空行
	raw = collapseBlankLines(raw);

	const truncated = raw.length > maxLen;
	const bodyStr = raw.substring(0, maxLen);

	let result = escapeMdV2(bodyStr);

	// 恢复标题为加粗
	for (const h of headings) {
		result = result.replace(escapeMdV2(h.placeholder), `*${escapeMdV2(h.text)}*`);
	}

	if (truncated) {
		result += '\n\n_… 正文过长，已截断 …_';
	}

	return result;
}
