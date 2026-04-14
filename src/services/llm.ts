/** 使用 OpenAI compatible API 对邮件正文进行 AI 分析（验证码 + 摘要 + 标签） */

import { extractLinks, prepareBody } from "@utils/format";
import { http } from "@utils/http";
import { LLM_TIMEOUT_MS, MAX_LINKS } from "@/constants";

/** 从逗号分隔的 API Key 列表中随机选一个 */
function pickRandomKey(apiKeys: string): string {
  const keys = apiKeys
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return keys[Math.floor(Math.random() * keys.length)];
}

/** 调用 OpenAI compatible /v1/chat/completions 接口，支持 JSON mode */
async function callLLM(
  baseUrl: string,
  apiKeys: string,
  model: string,
  prompt: string,
  json?: boolean,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const data = await http
    .post(url, {
      headers: { Authorization: `Bearer ${pickRandomKey(apiKeys)}` },
      json: {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        ...(json && { response_format: { type: "json_object" } }),
      },
      timeout: LLM_TIMEOUT_MS,
    })
    .json<{ choices?: Array<{ message: { content: string } }> }>();

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM API returned no choices");
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
  /** 是否为垃圾邮件 */
  isJunk: boolean;
  /** 垃圾邮件置信度 0-1 */
  junkConfidence: number;
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
      ? `\n\nLinks found in this email:\n${safeLinks.map((l, i) => `${i + 1}. [${l.label.replace(/[[\]]/g, "")}](${l.url})`).join("\n")}\n`
      : "";

  const linkRule =
    safeLinks.length > 0
      ? `- If the email contains important actionable links (login, verification, activation, confirmation, password reset, etc.), include them in the summary using Markdown link syntax [text](url). Skip tracking/pixel/unsubscribe links\n`
      : "";

  const prompt =
    `Analyze the following email and return a JSON object with these fields:\n\n` +
    `1. "verification_code": If the email contains a verification code, OTP, passcode, security code, or similar one-time code, extract the exact code (digits/letters only). Otherwise set to null.\n` +
    `   - If a verification code is found, set "summary" to an empty string (skip summarization to save tokens).\n\n` +
    `2. "summary": A bullet-point summary of the email (3-6 bullets).\n` +
    `   Language rules:\n` +
    `   - If the email is in English, write the summary in English\n` +
    `   - If the email is in any other language, write the summary in 简体中文\n` +
    `   Rules:\n` +
    `   - Each bullet starts with "• "\n` +
    `   - Do not use "the user" as subject, no lead-ins like "the email says"\n` +
    `   - State directly what happened, what the key data is, and what action is needed\n` +
    linkRule +
    `   - You may use Markdown formatting: **bold**, _italic_, \`code\`\n\n` +
    `3. "tags": An array of 1-3 PascalCase tags for this email.\n` +
    `   Rules:\n` +
    `   - If the email is in English, write tags in English; otherwise write tags in 简体中文\n` +
    `   - Each tag must be PascalCase (first letter of each word capitalized, no spaces or underscores), no "#" prefix (e.g. "PasswordReset", "Github", "OrderConfirmation")\n` +
    `   - Capture: sender/service name, category (notification, newsletter, promotion, verification), key topic\n\n` +
    `4. "junk": An object with junk/spam classification.\n` +
    `   - "is_junk": true if this is spam, phishing, unsolicited marketing, scam, or bulk promotional email with no personal relevance; false otherwise.\n` +
    `   - "confidence": A float 0.0–1.0 indicating how confident you are in the junk classification.\n` +
    `   - Transactional emails (receipts, order confirmations, notifications from services the user signed up for), newsletters from subscribed services, and any email with verification codes are NOT junk.\n\n` +
    `Output ONLY valid JSON, no other text. Example:\n` +
    `{"verification_code": null, "summary": "• ...", "tags": ["Github", "Verification", "Security"], "junk": {"is_junk": false, "confidence": 0.05}}\n\n` +
    `Subject: ${subject}\n\n` +
    `Body:\n${body}` +
    linksSection;

  const raw = await callLLM(baseUrl, apiKey, model, prompt, true);

  // 解析 JSON，容忍 markdown code fence 包裹
  const jsonStr = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(jsonStr) as {
      verification_code?: string | null;
      summary?: string;
      tags?: string[];
      junk?: { is_junk?: boolean; confidence?: number };
    };
    const code = parsed.verification_code ?? null;
    const isJunk = parsed.junk?.is_junk === true;
    const junkConfidence = Math.min(
      1,
      Math.max(0, parsed.junk?.confidence ?? 0),
    );
    return {
      verificationCode: code && /^[A-Za-z0-9-]{4,12}$/.test(code) ? code : null,
      summary: parsed.summary ?? "",
      tags: (parsed.tags ?? []).slice(0, 5),
      isJunk,
      junkConfidence,
    };
  } catch {
    // JSON 解析失败，抛出错误，不编辑消息，保存到 failed_emails 等待重试
    throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
  }
}
