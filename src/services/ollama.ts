/** 使用 Ollama 对邮件正文进行 AI 摘要 */

const MAX_BODY_CHARS = 4000;

/** 去除文本中的所有超链接（Markdown 链接保留文字，裸链接直接删除） */
function stripLinks(text: string): string {
	// [文字](url) → 文字
	let out = text.replace(/\[([^\]]*)\]\(https?:\/\/[^)]*\)/g, '$1');
	// 裸 http/https URL
	out = out.replace(/https?:\/\/\S+/g, '');
	return out;
}

/** 调用 Ollama /api/generate 接口，返回摘要文本 */
export async function summarizeEmail(ollamaUrl: string, model: string, subject: string, rawBody: string): Promise<string> {
	const stripped = stripLinks(rawBody);
	const body = stripped.length > MAX_BODY_CHARS ? stripped.slice(0, MAX_BODY_CHARS) + '...' : stripped;
	const prompt =
		`你是一个邮件助手。请用中文简洁地总结以下邮件内容，3到5句话，直接输出摘要，不要任何前缀或说明。\n\n` +
		`邮件主题：${subject}\n\n` +
		`邮件正文：\n${body}`;

	const resp = await fetch(`${ollamaUrl}/api/generate`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model, prompt, stream: false }),
	});

	if (!resp.ok) {
		throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
	}

	const data = (await resp.json()) as { response: string };
	return data.response.trim();
}
