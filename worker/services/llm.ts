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
  /** 一句话摘要（~30 字，用于邮件列表显示） */
  shortSummary: string;
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
    `3. "short_summary": A SINGLE short line (max ~40 characters, no line breaks, no markdown, no bullet) suitable for a list preview.\n` +
    `   - Same language rule as "summary" (English if email is English, else 简体中文)\n` +
    `   - Capture the core intent / key fact in a compact form. Examples: "GitHub 登录验证码", "LinkedIn weekly digest"\n` +
    `   - For order / transaction emails (order confirmation, shipping update, payment receipt, refund), include the key identifiers: merchant + status + one of (order #, amount, or tracking #). Examples: "Amazon 订单 #112-3456 已发货", "Uber 支付 ¥128 成功", "Stripe 退款 $29.99 已到账"\n` +
    `   - Always produce a non-empty value, even if "summary" is empty (e.g. verification code emails)\n\n` +
    `4. "tags": An array of 1-3 PascalCase tags for this email.\n` +
    `   Rules:\n` +
    `   - If the email is in English, write tags in English; otherwise write tags in 简体中文\n` +
    `   - Each tag must be PascalCase (first letter of each word capitalized, no spaces or underscores), no "#" prefix (e.g. "PasswordReset", "Github", "OrderConfirmation")\n` +
    `   - Capture: sender/service name, category (notification, newsletter, promotion, verification), key topic\n\n` +
    `5. "junk": An object with junk/spam classification.\n` +
    `   - "is_junk": true if this is spam, phishing, unsolicited marketing, scam, or bulk promotional email with no personal relevance; false otherwise.\n` +
    `   - "confidence": A float 0.0–1.0 indicating how confident you are in the junk classification.\n` +
    `   - Transactional emails (receipts, order confirmations, notifications from services the user signed up for), newsletters from subscribed services, and any email with verification codes are NOT junk.\n\n` +
    `Output ONLY valid JSON, no other text. Example:\n` +
    `{"verification_code": null, "summary": "• ...", "short_summary": "GitHub login verification code", "tags": ["Github", "Verification", "Security"], "junk": {"is_junk": false, "confidence": 0.05}}\n\n` +
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
      short_summary?: string;
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
      shortSummary: (parsed.short_summary ?? "").trim().replace(/\s+/g, " "),
      tags: (parsed.tags ?? []).slice(0, 5),
      isJunk,
      junkConfidence,
    };
  } catch {
    // JSON 解析失败，抛出错误，不编辑消息，保存到 failed_emails 等待重试
    throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
  }
}

// ─── Reminder metadata extraction ───────────────────────────────────────────

/** LLM 提取的提醒元数据 —— 用于预填提醒表单（机票/酒店/订单等场景） */
export interface ReminderMetadata {
  /** 建议的提醒日期 YYYY-MM-DD（按 timezone 下 wall-clock 解释；null 表示无可提取） */
  remindDate: string | null;
  /** 建议的提醒时间 HH:MM（24h；null 表示无可提取） */
  remindTime: string | null;
  /** IANA 时区名（例如 Asia/Shanghai）；无明确信号时为 null（前端回落到设备时区） */
  timezone: string | null;
  /** 建议的备注文案（含 emoji + 关键标识）；可为空字符串 */
  text: string | null;
  /** 置信度 0–1，前端 < 0.5 时不自动预填 */
  confidence: number;
}

/** 一次 LLM 调用：从邮件里抽取"提醒应该在何时响"的元数据。
 *  目标场景：机票（起飞前 3h）/ 酒店（入住当天上午）/ 火车票 / 餐厅订位 / 快递取件 / 会议等。
 *  非可操作邮件（营销、验证码、对账单……）→ confidence < 0.3，前端忽略。
 *
 *  注意：返回的是"建议提醒时间"，不是"事件时间"——LLM 内部判断合理 offset。 */
export async function extractReminderMetadata(
  baseUrl: string,
  apiKey: string,
  model: string,
  subject: string,
  rawBody: string,
  nowIso: string,
): Promise<ReminderMetadata> {
  const body = prepareBody(rawBody);

  const prompt =
    `You are extracting "when should the reminder fire" from an email so a UI can prefill its date/time inputs.\n\n` +
    `Current time: ${nowIso} (use this to resolve relative dates like "tomorrow"; only return future times).\n\n` +
    `Detect if the email contains a concrete future event the user will want to be reminded about, e.g.:\n` +
    `- Flight (remind ~3 hours before departure)\n` +
    `- Hotel reservation (remind morning of check-in, ~10:00 local)\n` +
    `- Train / bus ticket (remind ~1 hour before departure)\n` +
    `- Restaurant / appointment / meeting (remind ~30 minutes before)\n` +
    `- Package pickup / delivery window (remind near the start of the window)\n` +
    `- Bill due date / deadline (remind ~1 day before, at 09:00 local)\n` +
    `- Event ticket (concert, movie, sports — remind ~2 hours before)\n\n` +
    `Pick the SINGLE most actionable event. If multiple legs (e.g., round-trip), pick the next upcoming one.\n` +
    `If the email is not actionable (newsletter, marketing, verification code, receipt with no future event), set confidence < 0.3 and remind_date/remind_time/timezone/text to null.\n\n` +
    `Return JSON with these fields:\n` +
    `1. "remind_date": "YYYY-MM-DD" wall-clock date in the timezone below, or null.\n` +
    `2. "remind_time": "HH:MM" 24h wall-clock time in the timezone below, or null.\n` +
    `3. "timezone": IANA name (e.g. "Asia/Shanghai", "America/Los_Angeles", "Europe/London"). Use the event location's timezone if mentioned; null if unknown.\n` +
    `4. "text": A short note (≤ 40 chars, with one leading emoji, in 简体中文 unless the email is purely English) capturing the key identifier. Examples:\n` +
    `   - "✈️ CA1234 起飞 (PVG→LAX)"\n` +
    `   - "🏨 入住 Hilton 上海"\n` +
    `   - "🚄 G123 北京南→上海虹桥"\n` +
    `   - "🍽️ Le Bernardin 8pm reservation"\n` +
    `   - "📦 顺丰待取件 SF1234"\n` +
    `   Set to null if no clear identifier.\n` +
    `5. "confidence": float 0.0–1.0. Use ≥ 0.7 only when date AND time AND a clear category are all extracted.\n\n` +
    `Output ONLY valid JSON, no other text. Examples:\n` +
    `{"remind_date": "2026-05-20", "remind_time": "07:00", "timezone": "Asia/Shanghai", "text": "✈️ CA1234 起飞", "confidence": 0.9}\n` +
    `{"remind_date": null, "remind_time": null, "timezone": null, "text": null, "confidence": 0.1}\n\n` +
    `Subject: ${subject}\n\nBody:\n${body}`;

  const raw = await callLLM(baseUrl, apiKey, model, prompt, true);

  const jsonStr = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  let parsed: {
    remind_date?: string | null;
    remind_time?: string | null;
    timezone?: string | null;
    text?: string | null;
    confidence?: number;
  };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `LLM returned invalid JSON for reminder metadata: ${raw.slice(0, 200)}`,
    );
  }

  const date =
    typeof parsed.remind_date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(parsed.remind_date)
      ? parsed.remind_date
      : null;
  const time =
    typeof parsed.remind_time === "string" &&
    /^\d{2}:\d{2}$/.test(parsed.remind_time)
      ? parsed.remind_time
      : null;
  const tz =
    typeof parsed.timezone === "string" &&
    /^[A-Za-z]+\/[A-Za-z_+\-/0-9]+$/.test(parsed.timezone)
      ? parsed.timezone
      : null;
  const text =
    typeof parsed.text === "string" ? parsed.text.trim().slice(0, 60) : null;
  const confidence = Math.min(1, Math.max(0, parsed.confidence ?? 0));

  return {
    remindDate: date,
    remindTime: time,
    timezone: tz,
    text: text || null,
    confidence,
  };
}
