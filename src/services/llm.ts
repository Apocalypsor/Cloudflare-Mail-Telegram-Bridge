/** 使用 OpenAI compatible API 对邮件正文进行 AI 分析（验证码 + 摘要 + 标签） */

import { MAX_LINKS } from '../constants';
import { extractLinks, prepareBody } from '../utils/format';

/** JSON Schema 定义，用于 Structured Outputs */
const EMAIL_ANALYSIS_SCHEMA = {
	name: 'email_analysis',
	strict: true,
	schema: {
		type: 'object',
		properties: {
			verification_code: {
				type: ['string', 'null'],
				description: 'Verification code / OTP extracted from the email, or null if none',
			},
			summary: {
				type: 'string',
				description: 'Bullet-point summary of the email (3-6 bullets, each starting with "• ")',
			},
			tags: {
				type: 'array',
				items: { type: 'string' },
				description: '1-3 short keyword tags for the email',
			},
		},
		required: ['verification_code', 'summary', 'tags'],
		additionalProperties: false,
	},
} as const;

/** 调用 OpenAI compatible /v1/chat/completions 接口，使用 Structured Outputs */
async function callLLM(
	baseUrl: string,
	apiKey: string,
	model: string,
	prompt: string,
	jsonSchema?: { name: string; strict: boolean; schema: Record<string, unknown> },
): Promise<string> {
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
			...(jsonSchema && { response_format: { type: 'json_schema', json_schema: jsonSchema } }),
		}),
	});

	if (!resp.ok) {
		throw new Error(`LLM API ${resp.status}: ${await resp.text()}`);
	}

	const data = (await resp.json()) as { choices?: Array<{ message: { content: string } }> };
	const content = data.choices?.[0]?.message?.content;
	if (!content) throw new Error('LLM API returned no choices');
	return content.trim();
}

/** LLM 一次调用返回结果 */
export interface EmailAnalysis {
	/** 验证码（如有） */
	verificationCode: string | null;
	/** 摘要（bullet list） */
	summary: string;
	/** 标签 */
	tags: string[];
}

/** 一次 LLM 调用完成邮件分析：验证码提取 + 摘要 + 标签 */
export async function analyzeEmail(
	baseUrl: string,
	apiKey: string,
	model: string,
	subject: string,
	rawBody: string,
): Promise<EmailAnalysis> {
	const body = prepareBody(rawBody);
	const links = extractLinks(rawBody);

	const safeLinks = links.slice(0, MAX_LINKS);
	const linksSection =
		safeLinks.length > 0
			? `\n\nLinks found in this email:\n${safeLinks.map((l, i) => `${i + 1}. [${l.label.replace(/[\[\]]/g, '')}](${l.url})`).join('\n')}\n`
			: '';

	const linkRule =
		safeLinks.length > 0
			? `- If the email contains important actionable links (login, verification, activation, confirmation, password reset, etc.), include them in the summary using Markdown link syntax [text](url). Skip tracking/pixel/unsubscribe links\n`
			: '';

	const prompt =
		`Analyze the following email and return a JSON object with these fields:\n\n` +
		`1. "verification_code": If the email contains a verification code, OTP, passcode, security code, or similar one-time code, extract the exact code (digits/letters only). Otherwise set to null.\n\n` +
		`2. "summary": A bullet-point summary of the email (3-6 bullets), using the SAME LANGUAGE as the email.\n` +
		`   Rules:\n` +
		`   - Each bullet starts with "• "\n` +
		`   - Do not use "the user" as subject, no lead-ins like "the email says"\n` +
		`   - State directly what happened, what the key data is, and what action is needed\n` +
		linkRule +
		`   - You may use Markdown formatting: **bold**, _italic_, \`code\`\n\n` +
		`3. "tags": An array of 1-3 short keyword tags for this email.\n` +
		`   Rules:\n` +
		`   - Use the SAME LANGUAGE as the email\n` +
		`   - Each tag 1-3 words, no "#" prefix\n` +
		`   - Capture: sender/service name, category (notification, newsletter, promotion, verification), key topic\n\n` +
		`Subject: ${subject}\n\n` +
		`Body:\n${body}` +
		linksSection;

	const raw = await callLLM(baseUrl, apiKey, model, prompt, EMAIL_ANALYSIS_SCHEMA);
	const parsed = JSON.parse(raw) as { verification_code: string | null; summary: string; tags: string[] };
	const code = parsed.verification_code;

	return {
		verificationCode: code && /^[A-Za-z0-9\-]{4,12}$/.test(code) ? code : null,
		summary: parsed.summary,
		tags: parsed.tags.slice(0, 5),
	};
}
