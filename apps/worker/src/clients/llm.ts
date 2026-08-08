/** 使用 Workers AI 优先、OpenAI Responses API fallback 对邮件正文做 AI 分析 */

import { LLM_TIMEOUT_MS, MAX_LINKS } from "@worker/constants";
import type { Env } from "@worker/types";
import { extractLinks, prepareBody } from "@worker/utils/mail/llm-input";
import { trimTrailingSlashes } from "@worker/utils/string";

interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  text?: string;
  error?: string | { message?: string };
  response?: unknown;
}

interface ResponsesStreamState {
  text: string;
  fallbackText: string | null;
}

interface WorkersAiChatCompletion {
  choices?: {
    message?: { content?: string | null };
    text?: string | null;
  }[];
  output_text?: string;
  response?: string;
}

/** LLM 一次调用返回结果 */
export interface EmailAnalysis {
  /** 摘要（bullet list） */
  summary: string;
  /** 一句话摘要（用于邮件列表显示） */
  shortSummary: string;
  /** 标签 */
  tags: string[];
  /** 是否为垃圾邮件 */
  isJunk: boolean;
  /** 垃圾邮件置信度 0-1 */
  junkConfidence: number;
}

const WORKERS_AI_MODEL = "@cf/zai-org/glm-4.7-flash";

export const hasLlm = (env: Env): boolean =>
  !!env.AI || !!(env.LLM_API_URL && env.LLM_API_KEY && env.LLM_MODEL);

/** 一次 LLM 调用完成邮件分析：摘要 + 标签 */
export const analyzeEmail = async (
  env: Env,
  subject: string,
  rawBody: string,
): Promise<EmailAnalysis> => {
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
    `1. "summary": A bullet-point summary of the email (3-6 bullets).\n` +
    `   Language rules:\n` +
    `   - If the email is in English, write the summary in English\n` +
    `   - If the email is in any other language, write the summary in 简体中文\n` +
    `   Rules:\n` +
    `   - Always summarize the email, including verification-code, OTP, passcode, security-code, or login-code emails\n` +
    `   - Each bullet starts with "• "\n` +
    `   - Do not use "the user" as subject, no lead-ins like "the email says"\n` +
    `   - State directly what happened, what the key data is, and what action is needed\n` +
    linkRule +
    `   - You may use Markdown formatting: **bold**, _italic_, \`code\`\n\n` +
    `2. "short_summary": A SINGLE compact line (target max ~60 characters, no line breaks, no markdown, no bullet) suitable for a list preview.\n` +
    `   - Same language rule as "summary" (English if email is English, else 简体中文)\n` +
    `   - Capture concrete key facts, not a generic category. Prefer: sender/service + item/event/name + time/date + identifier/status.\n` +
    `   - For shopping/order/receipt/shipping/refund emails, include merchant + purchased item or service + order number (if present) + status/time/amount. Examples: "Amazon AirPods 订单#112 已发货", "Apple MacBook 5月10日付款成功", "Uber 行程¥128 已支付"\n` +
    `   - For flight/train/travel tickets, include carrier + flight/train number + route + departure/arrival time/date + booking/order number or status when present. Examples: "UA857 SFO→PVG 5月12日20:30 已确认", "国航CA982 6月1日 北京→纽约 已出票"\n` +
    `   - For hotel/lodging bookings, include hotel name + city/room if useful + check-in/check-out date + booking/order number or status when present. Examples: "东京希尔顿 5月12日入住 订单#ABC123", "Marriott NYC 6/1-6/3 booking confirmed"\n` +
    `   - If details exceed the length target, keep the most actionable identifiers first: item/hotel/flight name, time/date, order/booking/tracking number, status.\n` +
    `   - Always produce a non-empty value\n\n` +
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
    `{"summary": "• ...", "short_summary": "GitHub login verification code", "tags": ["Github", "Verification", "Security"], "junk": {"is_junk": false, "confidence": 0.05}}\n\n` +
    `Subject: ${subject}\n\n` +
    `Body:\n${body}` +
    linksSection;

  const raw = await callConfiguredLLM(env, prompt, true);

  // 解析 JSON，容忍 markdown code fence 包裹
  const jsonStr = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(jsonStr) as {
      summary?: string;
      short_summary?: string;
      tags?: string[];
      junk?: { is_junk?: boolean; confidence?: number };
    };
    const isJunk = parsed.junk?.is_junk === true;
    const junkConfidence = Math.min(
      1,
      Math.max(0, parsed.junk?.confidence ?? 0),
    );
    return {
      summary: parsed.summary ?? "",
      shortSummary: (parsed.short_summary ?? "").trim().replace(/\s+/g, " "),
      tags: (parsed.tags ?? []).slice(0, 5),
      isJunk,
      junkConfidence,
    };
  } catch {
    // JSON 解析失败，抛出错误，不编辑消息，保存到 failed_emails 等待重试
    throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
  }
};

const callConfiguredLLM = async (
  env: Env,
  prompt: string,
  json?: boolean,
): Promise<string> => {
  try {
    if (env.AI) return await callWorkersAI(env.AI, prompt, json);
  } catch (err) {
    if (!env.LLM_API_URL || !env.LLM_API_KEY || !env.LLM_MODEL) throw err;
    console.warn("Workers AI failed, falling back to LLM endpoint", err);
  }

  if (!env.LLM_API_URL || !env.LLM_API_KEY || !env.LLM_MODEL)
    throw new Error("LLM not configured");

  return callLLM(env.LLM_API_URL, env.LLM_API_KEY, env.LLM_MODEL, prompt, json);
};

const callWorkersAI = async (
  ai: Ai,
  prompt: string,
  json?: boolean,
): Promise<string> => {
  const response = await ai.run(WORKERS_AI_MODEL, {
    messages: [{ role: "user", content: prompt }],
    ...(json && { response_format: { type: "json_object" } }),
  });
  const content = extractWorkersAIText(response);
  if (!content) throw new Error("Workers AI returned no output text");
  return content.trim();
};

/** 从逗号分隔的 API Key 列表中随机选一个 */
const pickRandomKey = (apiKeys: string): string => {
  const keys = apiKeys
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return keys[Math.floor(Math.random() * keys.length)];
};

const extractWorkersAIText = (response: unknown): string | null => {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return null;

  const result = response as WorkersAiChatCompletion;
  if (typeof result.response === "string") return result.response;
  if (typeof result.output_text === "string") return result.output_text;

  const content =
    result.choices?.[0]?.message?.content ?? result.choices?.[0]?.text;
  return typeof content === "string" ? content : null;
};

/** 调用 OpenAI /v1/responses 接口，以 SSE 流式读取文本增量。 */
const callLLM = async (
  baseUrl: string,
  apiKeys: string,
  model: string,
  prompt: string,
  json?: boolean,
): Promise<string> => {
  const url = `${trimTrailingSlashes(baseUrl)}/responses`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${pickRandomKey(apiKeys)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: prompt }],
          },
        ],
        store: false,
        stream: true,
        ...(json && { text: { format: { type: "json_object" } } }),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `LLM API ${response.status}: ${body.slice(0, 500) || response.statusText}`,
      );
    }
    if (!response.body) throw new Error("LLM API returned no stream body");

    const content = await readResponsesStream(response.body);
    if (!content) throw new Error("LLM API returned no output text");
    return content.trim();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("LLM API request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

const readResponsesStream = async (
  body: ReadableStream<Uint8Array>,
): Promise<string> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: ResponsesStreamState = { text: "", fallbackText: null };
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = processSseBuffer(buffer, state);
  }

  buffer += decoder.decode();
  if (buffer.trim()) processSseBlock(buffer, state);

  return state.text || state.fallbackText || "";
};

const processSseBuffer = (
  buffer: string,
  state: ResponsesStreamState,
): string => {
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = parts.pop() ?? "";
  for (const part of parts) processSseBlock(part, state);
  return remainder;
};

const processSseBlock = (block: string, state: ResponsesStreamState): void => {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return;

  let event: ResponsesStreamEvent;
  try {
    event = JSON.parse(data) as ResponsesStreamEvent;
  } catch {
    throw new Error(`LLM stream returned invalid event: ${data.slice(0, 200)}`);
  }

  if (event.type === "response.output_text.delta" && event.delta) {
    state.text += event.delta;
    return;
  }

  if (event.type === "response.output_text.done" && event.text) {
    state.fallbackText = event.text;
    return;
  }

  if (event.type === "response.completed") {
    state.fallbackText =
      extractResponseText(event.response) ?? state.fallbackText;
    return;
  }

  if (
    event.type === "error" ||
    event.type === "response.failed" ||
    event.type === "response.incomplete"
  ) {
    throw new Error(streamErrorMessage(event));
  }
};

const streamErrorMessage = (event: ResponsesStreamEvent): string => {
  if (typeof event.error === "string") return event.error;
  if (event.error?.message) return event.error.message;

  const response = event.response;
  if (response && typeof response === "object") {
    const error = (response as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string") return error.message;
    const incomplete = (
      response as { incomplete_details?: { reason?: unknown } }
    ).incomplete_details;
    if (typeof incomplete?.reason === "string") {
      return `LLM response incomplete: ${incomplete.reason}`;
    }
  }

  return `LLM stream error: ${event.type ?? "unknown"}`;
};

const extractResponseText = (response: unknown): string | null => {
  if (!response || typeof response !== "object") return null;
  const outputText = (response as { output_text?: unknown }).output_text;
  if (typeof outputText === "string") return outputText;

  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;

  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const type = (part as { type?: unknown }).type;
      const text = (part as { text?: unknown }).text;
      if (type === "output_text" && typeof text === "string") {
        parts.push(text);
      }
    }
  }

  return parts.length > 0 ? parts.join("") : null;
};
