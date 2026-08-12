import { LLM_TIMEOUT_MS, MAX_LINKS } from "@worker/constants";
import type { Env } from "@worker/types";
import { extractLinks, prepareBody } from "@worker/utils/mail/llm-input";
import { trimTrailingSlashes } from "@worker/utils/string";
import type { EmailAnalysis, LLMClientEnv } from "./types";
import { readResponsesStream } from "./utils";

export type { EmailAnalysis } from "./types";

export class LLMClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly model: string;

  constructor(env: LLMClientEnv) {
    if (!env.LLM_API_URL || !env.LLM_API_KEY || !env.LLM_MODEL) {
      throw new Error("LLM not configured");
    }
    this.apiKey = env.LLM_API_KEY;
    this.apiUrl = env.LLM_API_URL;
    this.model = env.LLM_MODEL;
  }

  static isConfigured(env: Env): boolean {
    return !!(env.LLM_API_URL && env.LLM_API_KEY && env.LLM_MODEL);
  }

  async analyzeEmail(subject: string, rawBody: string): Promise<EmailAnalysis> {
    const body = prepareBody(rawBody);
    const safeLinks = extractLinks(rawBody).slice(0, MAX_LINKS);
    const linksSection =
      safeLinks.length > 0
        ? `\n\nLinks found in this email:\n${safeLinks.map((link, index) => `${index + 1}. [${link.label.replace(/[[\]]/g, "")}](${link.url})`).join("\n")}\n`
        : "";
    const linkRule =
      safeLinks.length > 0
        ? "- If the email contains important actionable links (login, verification, activation, confirmation, password reset, etc.), include them in the summary using Markdown link syntax [text](url). Skip tracking/pixel/unsubscribe links\n"
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

    const raw = await this.call(prompt, true);
    const json = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");

    try {
      const parsed = JSON.parse(json) as {
        summary?: string;
        short_summary?: string;
        tags?: string[];
        junk?: { is_junk?: boolean; confidence?: number };
      };
      return {
        summary: parsed.summary ?? "",
        shortSummary: (parsed.short_summary ?? "").trim().replace(/\s+/g, " "),
        tags: (parsed.tags ?? []).slice(0, 5),
        isJunk: parsed.junk?.is_junk === true,
        junkConfidence: Math.min(1, Math.max(0, parsed.junk?.confidence ?? 0)),
      };
    } catch {
      throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
    }
  }

  private async call(prompt: string, json?: boolean): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
      const response = await fetch(
        `${trimTrailingSlashes(this.apiUrl)}/responses`,
        {
          method: "POST",
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${this.pickRandomKey()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
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
        },
      );

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
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("LLM API request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private pickRandomKey(): string {
    const keys = this.apiKey
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    return keys[Math.floor(Math.random() * keys.length)];
  }
}
