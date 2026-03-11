import { base64urlToString } from '../utils/base64url';
import { gmailGet } from './email/gmail';

/** 从 Gmail API 获取邮件正文 HTML，优先 HTML，fallback 到纯文本 */
export async function fetchMailContent(accessToken: string, gmailMessageId: string): Promise<string | null> {
	const msg = await gmailGet(accessToken, `/users/me/messages/${gmailMessageId}?format=full`);
	const html = extractPartByMime(msg.payload, 'text/html');
	if (html) return html;

	const plain = extractPartByMime(msg.payload, 'text/plain');
	if (plain) return wrapPlainText(plain);

	return null;
}

/** 递归提取 payload 中指定 MIME 类型的内容 */
function extractPartByMime(payload: any, mimeType: string): string | null {
	if (!payload) return null;

	if (payload.mimeType === mimeType && payload.body?.data) {
		return base64urlToString(payload.body.data);
	}

	if (payload.parts) {
		for (const part of payload.parts) {
			const content = extractPartByMime(part, mimeType);
			if (content) return content;
		}
	}

	return null;
}

/** 将纯文本包裹成可读的 HTML 页面 */
function wrapPlainText(text: string): string {
	const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:monospace;white-space:pre-wrap;word-break:break-word;max-width:800px;margin:2em auto;padding:0 1em;line-height:1.5;color:#333}</style></head><body>${escaped}</body></html>`;
}
