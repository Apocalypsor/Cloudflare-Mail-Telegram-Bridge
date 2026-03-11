import type { Env } from '../types';
import { toTelegramMdV2 } from '../utils/format';
import { escapeMdV2 } from '../utils/markdown-v2';
import { extractLinks, extractVerificationCode, generateTags, summarizeEmail } from './llm';
import { reportErrorToObservability } from './observability';
import { editMessageCaption, editTextMessage } from './telegram';

export interface LlmEditContext {
	env: Env;
	tgToken: string;
	chatId: string;
	tgMessageId: number;
	isCaption: boolean;
	header: string;
	subject: string;
	plainBody: string;
	/** 用于验证码场景：编辑后保留可展开引用正文 */
	formattedBody?: string;
	keyboard: unknown;
}

/** 将文本包裹为 Telegram 可展开引用块（expandable blockquote） */
export function wrapExpandableQuote(text: string): string {
	if (!text) return '';
	let inCode = false;
	const processed: string[] = [];
	for (const line of text.split('\n')) {
		if (/^```/.test(line)) {
			inCode = !inCode;
			continue;
		}
		let out = inCode ? escapeMdV2(line) : line;
		if (out.startsWith('>')) out = `\\${out}`;
		processed.push(out);
	}
	return processed.map((line, i) => (i === 0 ? `**>${line}` : `>${line}`)).join('\n') + '||';
}

/** 核心 LLM 处理：提取验证码 → 生成摘要 + 标签 → 编辑 Telegram 消息 */
export async function runLlmProcessing(ctx: LlmEditContext): Promise<void> {
	const { env } = ctx;
	const llmUrl = env.LLM_API_URL!;
	const llmKey = env.LLM_API_KEY!;
	const llmModel = env.LLM_MODEL!;

	const editMessage = (newText: string) =>
		ctx.isCaption
			? editMessageCaption(ctx.tgToken, ctx.chatId, ctx.tgMessageId, newText, ctx.keyboard)
			: editTextMessage(ctx.tgToken, ctx.chatId, ctx.tgMessageId, newText, ctx.keyboard);

	// 第一步：尝试用 LLM 提取验证码
	const verifyCode = await extractVerificationCode(llmUrl, llmKey, llmModel, ctx.subject, ctx.plainBody).catch((err) => {
		reportErrorToObservability(env, 'llm.verify_code_failed', err, { subject: ctx.subject });
		return null;
	});

	if (verifyCode && ctx.formattedBody) {
		const codeSection = `*🔒 验证码:*  \`${escapeMdV2(verifyCode)}\`\n\n`;
		await editMessage(ctx.header + codeSection + wrapExpandableQuote(ctx.formattedBody));
		console.log(`Verification code extracted: ${verifyCode}`);
		return;
	}

	// 第二步：无验证码 → 生成摘要 + 标签
	const links = extractLinks(ctx.plainBody);
	const [summary, tags] = await Promise.all([
		summarizeEmail(llmUrl, llmKey, llmModel, ctx.subject, ctx.plainBody, links),
		generateTags(llmUrl, llmKey, llmModel, ctx.subject, ctx.plainBody).catch((err) => {
			reportErrorToObservability(env, 'llm.tags_failed', err, { subject: ctx.subject });
			return [] as string[];
		}),
	]);

	const tagsLine = tags.length > 0 ? `\n\n${tags.map((t) => `\\#${escapeMdV2(t.replace(/\s+/g, '_'))}`).join('  ')}` : '';
	const summarySection = `*${escapeMdV2('🤖 AI 摘要')}*\n\n${toTelegramMdV2(summary)}`;
	await editMessage(ctx.header + summarySection + tagsLine);
}
