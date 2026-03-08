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
		`Extract the key points of the following email in at most 5 concise sentences, using the SAME LANGUAGE as the email.\n` +
		`Rules:\n` +
		`- Do not use "the user" as subject, no lead-ins like "the email says" or "you received"\n` +
		`- State directly what happened, what the key data is, and what action is needed\n` +
		`- If the email contains a verification code, OTP, or activation code, you MUST include the exact code prominently\n` +
		`- Output only the summary, no prefix or explanation\n\n` +
		`Subject: ${subject}\n\n` +
		`Body:\n${body}`;

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
