/** 使用 OpenAI compatible API 对邮件正文进行 AI 摘要 & 标签生成 */

const MAX_BODY_CHARS = 4000;

/** 去除文本中的所有超链接（Markdown 链接保留文字，裸链接直接删除） */
function stripLinks(text: string): string {
	// [文字](url) → 文字
	let out = text.replace(/\[([^\]]*)\]\(https?:\/\/[^)]*\)/g, '$1');
	// 裸 http/https URL
	out = out.replace(/https?:\/\/\S+/g, '');
	return out;
}

/** 预处理邮件正文：去链接 + 截断 */
function prepareBody(rawBody: string): string {
	const stripped = stripLinks(rawBody);
	return stripped.length > MAX_BODY_CHARS ? stripped.slice(0, MAX_BODY_CHARS) + '...' : stripped;
}

/** 调用 OpenAI compatible /v1/chat/completions 接口 */
async function callLLM(baseUrl: string, apiKey: string, model: string, prompt: string): Promise<string> {
	const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
	const resp = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: [{ role: 'user', content: prompt }],
			stream: false,
		}),
	});

	if (!resp.ok) {
		throw new Error(`LLM API ${resp.status}: ${await resp.text()}`);
	}

	const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
	return data.choices[0].message.content.trim();
}

/** 调用 LLM 生成邮件摘要 */
export async function summarizeEmail(baseUrl: string, apiKey: string, model: string, subject: string, rawBody: string): Promise<string> {
	const body = prepareBody(rawBody);
	const prompt =
		`Extract the key points of the following email in at most 5 concise sentences, using the SAME LANGUAGE as the email.\n` +
		`Rules:\n` +
		`- Do not use "the user" as subject, no lead-ins like "the email says" or "you received"\n` +
		`- State directly what happened, what the key data is, and what action is needed\n` +
		`- If the email contains a verification code, OTP, or activation code, you MUST include the exact code prominently\n` +
		`- You may use Markdown formatting: **bold**, _italic_, \`code\` for codes/numbers, bullet lists\n` +
		`- Output only the summary, no prefix or explanation\n\n` +
		`Subject: ${subject}\n\n` +
		`Body:\n${body}`;

	return callLLM(baseUrl, apiKey, model, prompt);
}

/** 调用 LLM 提取验证码，返回纯验证码字符串或 null */
export async function extractVerificationCode(
	baseUrl: string,
	apiKey: string,
	model: string,
	subject: string,
	rawBody: string,
): Promise<string | null> {
	const body = prepareBody(rawBody);
	const prompt =
		`Does the following email contain a verification code, OTP, passcode, identification code, security code, or similar one-time code?\n` +
		`Rules:\n` +
		`- If yes, output ONLY the code itself (digits/letters), nothing else\n` +
		`- If no, output exactly: NONE\n` +
		`- Do not include any explanation, prefix, or extra text\n\n` +
		`Subject: ${subject}\n\n` +
		`Body:\n${body}`;

	const result = await callLLM(baseUrl, apiKey, model, prompt);
	const cleaned = result.replace(/[`\s]/g, '');
	if (!cleaned || cleaned.toUpperCase() === 'NONE') return null;
	if (/^[A-Za-z0-9\-]{4,12}$/.test(cleaned)) return cleaned;
	return null;
}

/** 调用 LLM 为邮件生成 3-5 个标签 */
export async function generateTags(baseUrl: string, apiKey: string, model: string, subject: string, rawBody: string): Promise<string[]> {
	const body = prepareBody(rawBody);
	const prompt =
		`Generate 3 to 5 short tags (keywords) for the following email. ` +
		`Rules:\n` +
		`- Use the SAME LANGUAGE as the email for tags\n` +
		`- Each tag should be 1-3 words, no "#" prefix\n` +
		`- Tags should capture: sender/service name, email category (e.g. notification, newsletter, promotion, verification), and key topic\n` +
		`- Output ONLY the tags, one per line, no numbering or extra text\n\n` +
		`Subject: ${subject}\n\n` +
		`Body:\n${body}`;

	const raw = await callLLM(baseUrl, apiKey, model, prompt);
	return raw
		.split('\n')
		.map((t) => t.replace(/^[-•*\d.)\s#]+/, '').trim())
		.filter((t) => t.length > 0)
		.slice(0, 5);
}
