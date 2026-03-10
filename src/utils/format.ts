import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { escapeMdV2, findLongestValidMdV2Prefix, markdownToMdV2 } from './markdown-v2';

/** HTML → Markdown 转换器实例（linkedom DOM + turndown） */
const turndown = new TurndownService({
	bulletListMarker: '-',
	codeBlockStyle: 'fenced',
	emDelimiter: '_',
	strongDelimiter: '**',
});

// Strip images — Telegram can't render inline images
turndown.addRule('stripImages', {
	filter: 'img',
	replacement() {
		return '';
	},
});

function htmlToMarkdown(html: string): string {
	const { document } = parseHTML(html);
	for (const node of document.querySelectorAll('head, style, script')) {
		node.remove();
	}
	return turndown
		.turndown(document.body)
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** 修复 Telegram MarkdownV2 易出错片段（例如单独一行的 "***"） */
function sanitizeTelegramMdV2(md: string): string {
	return md.replace(/(^|\n)\*{3,}(?=\n|$)/g, '$1\\*\\*\\*');
}

/** 标准 Markdown → Telegram MarkdownV2 */
export function toTelegramMdV2(markdown: string): string {
	if (!markdown) return '';
	return markdownToMdV2(markdown).trimEnd();
}

function convertTelegramMdV2Safe(markdown: string): string {
	return sanitizeTelegramMdV2(toTelegramMdV2(markdown));
}

/**
 * 处理邮件正文：优先将 HTML 转 Markdown，fallback 到纯文本，超长截断并提示。
 * @param maxLen 本次可用的最大字符数（由调用方根据其他部分占用动态计算）
 */
export function formatBody(text: string | undefined, html: string | undefined, maxLen: number): string {
	let raw = '';

	if (html) {
		try {
			raw = htmlToMarkdown(html);
		} catch {
			// Turndown can throw on malformed URIs in links; fall through to plain text
			raw = '';
		}
	}

	if (!raw && text) {
		raw = text.trim();
	}

	if (!raw) return escapeMdV2('（正文为空）');

	// 残留 HTML 标签
	raw = raw.replace(/<[^>]*>/g, '');

	const truncated = raw.length > maxLen;
	const truncatedHint = `\n\n${toTelegramMdV2('*… 正文过长，已截断 …*')}`;
	const converted = convertTelegramMdV2Safe(raw);

	if (!truncated) {
		const validEnd = findLongestValidMdV2Prefix(converted);
		return validEnd === converted.length ? converted : escapeMdV2(raw);
	}

	const bounded = converted.slice(0, maxLen);
	const validEnd = findLongestValidMdV2Prefix(bounded);
	if (validEnd > 0) return `${bounded.slice(0, validEnd)}${truncatedHint}`;

	// 极端兜底：如果回退仍不安全，降级为纯文本。
	return `${escapeMdV2(raw.substring(0, maxLen))}${truncatedHint}`;
}
