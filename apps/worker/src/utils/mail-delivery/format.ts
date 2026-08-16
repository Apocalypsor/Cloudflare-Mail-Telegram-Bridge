import { type EmailAnalysis, LLMClient } from "@worker/clients/llm";
import { TelegramClient } from "@worker/clients/telegram";
import { MESSAGE_DATE_LOCALE, MESSAGE_DATE_TIMEZONE } from "@worker/constants";
import { t } from "@worker/i18n";
import type { Account, Env } from "@worker/types";
import { renderEmailBody } from "@worker/utils/mail/render";
import {
  toTelegramRichHtml,
  truncateMarkdown,
  truncateMarkdownBlocks,
} from "@worker/utils/mail/telegram-rich-html";
import { escapeHtmlText, truncateUnicodeText } from "@worker/utils/string";

const TG_HEADER_FIELD_LIMIT = 1_000;
const TG_TAG_LENGTH_LIMIT = 80;

/**
 * 邮件 → Telegram 消息的格式化层 —— delivery / retry 共用。
 * 纯计算 + 一个 LLM-edit side effect，不读 D1 / KV，不下结论性写入；
 * 调用方负责拼装、写 mapping、维护 keyboard。
 */

const buildTelegramHeader = (
  fromName: string,
  fromAddress: string,
  recipient: string,
  subject: string,
  accountEmail?: string,
): string => {
  const now = new Date();
  const date = now.toLocaleString(MESSAGE_DATE_LOCALE, {
    timeZone: MESSAGE_DATE_TIMEZONE,
  });
  const line = (label: string, value: string) => {
    const escapedValue = escapeHtmlText(
      truncateUnicodeText(value, TG_HEADER_FIELD_LIMIT),
    );
    return `${escapeHtmlText(label)} ${escapedValue}`;
  };
  const sender = fromName ? `${fromName} <${fromAddress}>` : fromAddress;
  const lines = [line(t("bridge:header.to"), recipient)];
  if (accountEmail && accountEmail.toLowerCase() !== recipient.toLowerCase()) {
    lines.push(line(t("bridge:header.account"), accountEmail));
  }
  lines.push(
    `${escapeHtmlText(t("bridge:header.time"))} <tg-time unix="${Math.floor(now.getTime() / 1_000)}" format="wDT">${escapeHtmlText(date)}</tg-time>`,
  );
  const escapedSubject = escapeHtmlText(
    truncateUnicodeText(subject, TG_HEADER_FIELD_LIMIT),
  );
  const escapedSender = escapeHtmlText(
    truncateUnicodeText(sender, TG_HEADER_FIELD_LIMIT),
  );
  return `<p><b>${escapedSubject}</b></p><details><summary>${escapedSender}</summary><p><b>${lines.join("<br>")}</b></p></details>`;
};

const buildRichVerificationCodeSection = (
  code: string,
  addBodySpacing = false,
): string =>
  `<p><b>${escapeHtmlText(t("bridge:verificationCode"))}</b> <code>${escapeHtmlText(code)}</code></p>${addBodySpacing ? "<p>&#160;</p>" : ""}`;

export const buildTelegramEmailHtml = (
  headerHtml: string,
  verificationCode: string | null,
  isAiGenerating: boolean,
): string => {
  const codeSection = verificationCode
    ? buildRichVerificationCodeSection(verificationCode, isAiGenerating)
    : "";
  const statusSection = isAiGenerating
    ? `<p>${escapeHtmlText(t("bridge:aiGenerating"))}</p>`
    : "";
  return `${headerHtml}${codeSection}${statusSection}`;
};

const STRONG_CONTEXT_RE =
  /verification\s+code|security\s+code|login\s+code|launch\s+code|sign[-\s]?in\s+code|one[-\s]?time\s+(?:code|password)|auth(?:entication)?\s+code|2fa\s+code|mfa\s+code|otp|passcode|验证码|校验码|动态码|确认码|安全码|一次性(?:代码|密码)|登录(?:代码|验证码)|驗證碼|校驗碼|認證碼|確認碼|安全碼/gi;

const AUTH_CONTEXT_RE =
  /verify|verification|security|login|launch\s+code|sign[-\s]?in|one[-\s]?time|authentication|account|2fa|mfa|otp|passcode|验证|校验|动态码|安全|登录|登入|驗證|認證/i;

const CODE_LINE_RE =
  /(?:your|this|the|use|enter|copy)\s+(?:code|passcode|otp)|(?:code|passcode|otp)\s*(?:is|:|：|=)|验证码|校验码|动态码|确认码|安全码|驗證碼|校驗碼|確認碼|安全碼/i;

const NEGATIVE_CONTEXT_RE =
  /promo(?:tional)?\s+code|coupon\s+code|discount\s+code|referral\s+code|invite\s+code|gift\s+code|tracking\s+(?:number|code)|order\s+(?:number|#)|优惠码|折扣码|邀请码|促销码|订单号|快递单号|物流单号|優惠碼|折扣碼|邀請碼|促銷碼|訂單號/i;

const COMPACT_CANDIDATE_RE =
  /(?<![A-Za-z0-9])([A-Z0-9][A-Z0-9-]{3,11})(?![A-Za-z0-9])/g;

const DIGIT_CANDIDATE_RE =
  /(?<![A-Za-z0-9-])(\d[\d -]{2,14}\d)(?![A-Za-z0-9-])/g;

const sanitizeText = (text: string): string =>
  text
    .replace(/\[([^\]]*)\]\((?:https?|mailto):[^)]*\)/gi, "$1")
    .replace(/https?:\/\/\S+|mailto:\S+/gi, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r/g, "\n");

const normalizeCandidate = (value: string): string | null => {
  const compact = value.replace(/\s+/g, "").replace(/[.,;:!?]+$/, "");
  const alnum = compact.replace(/-/g, "");

  if (!/^[A-Z0-9-]{4,12}$/.test(compact)) return null;
  if (!/[0-9]/.test(compact)) return null;
  if (alnum.length < 4 || alnum.length > 12) return null;
  if (compact.startsWith("-") || compact.endsWith("-")) return null;
  if (compact.includes("--")) return null;
  if (/^\d{1,2}-\d{1,2}(?:-\d{2,4})?$/.test(compact)) return null;
  if (/^(?:19|20)\d{6}$/.test(compact)) return null;

  return compact;
};

const findCandidateMatches = (
  text: string,
): Array<{
  code: string;
  index: number;
}> => {
  const matches: Array<{ code: string; index: number }> = [];

  for (const match of text.matchAll(COMPACT_CANDIDATE_RE)) {
    matches.push({ code: match[1], index: match.index ?? 0 });
  }

  for (const match of text.matchAll(DIGIT_CANDIDATE_RE)) {
    matches.push({
      code: match[1].replace(/[ -]/g, ""),
      index: match.index ?? 0,
    });
  }

  return matches;
};

const candidateScore = (code: string, distance: number): number => {
  let score = Math.min(distance, 200) / 200;
  if (/^\d{6}$/.test(code)) score -= 3;
  else if (/^\d{4,8}$/.test(code)) score -= 2;
  else if (/^[A-Z0-9-]{6,10}$/.test(code)) score -= 1;
  if (code.includes("-")) score += 0.2;
  return score;
};

const findBestCandidate = (
  text: string,
  anchorIndex: number,
): { code: string; score: number } | null => {
  let best: { code: string; score: number } | null = null;
  for (const match of findCandidateMatches(text)) {
    const code = normalizeCandidate(match.code);
    if (!code) continue;
    const score = candidateScore(code, Math.abs(match.index - anchorIndex));
    if (!best || score < best.score) best = { code, score };
  }
  return best;
};

const findCodeNearStrongContext = (text: string): string | null => {
  let best: { code: string; score: number } | null = null;

  for (const match of text.matchAll(STRONG_CONTEXT_RE)) {
    const contextStart = match.index ?? 0;
    const start = Math.max(0, contextStart - 80);
    const end = Math.min(text.length, contextStart + match[0].length + 180);
    const window = text.slice(start, end);

    const candidate = findBestCandidate(window, contextStart - start);
    if (candidate && (!best || candidate.score < best.score)) best = candidate;
  }

  return best?.code ?? null;
};

const findCodeInLineBlocks = (text: string): string | null => {
  const hasAuthContext = AUTH_CONTEXT_RE.test(text);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const strongLine = new RegExp(STRONG_CONTEXT_RE.source, "i").test(line);
    const codeLine = CODE_LINE_RE.test(line) && hasAuthContext;
    if (!strongLine && !codeLine) continue;

    const block = lines.slice(Math.max(0, i - 1), i + 3).join("\n");
    if (NEGATIVE_CONTEXT_RE.test(block)) continue;

    const candidate = findBestCandidate(block, block.indexOf(line));
    if (candidate) return candidate.code;
  }

  return null;
};

const extractVerificationCode = (
  subject: string,
  body: string,
): string | null => {
  const text = sanitizeText(`${subject}\n${body}`);
  if (!text.trim()) return null;

  return findCodeNearStrongContext(text) ?? findCodeInLineBlocks(text);
};

/** 从解析后的邮件中提取 TG 消息所需的各项内容（subject / header / LLM 用的纯文本） */
export const prepareEmailContent = (
  email: {
    subject?: string;
    to?: { address?: string }[];
    from?: { name?: string; address?: string };
    text?: string;
    html?: string;
  },
  account: Account,
) => {
  const subject = email.subject || t("common:label.noSubject");
  const recipient =
    email.to?.map((addr) => addr.address).join(", ") ||
    account.email ||
    `Account #${account.id}`;
  const header = buildTelegramHeader(
    email.from?.name || "",
    email.from?.address || t("common:label.unknown"),
    recipient,
    subject,
    account.email ?? undefined,
  );
  const bodyMarkdown = renderEmailBody(email.text, email.html).markdown;
  const plainBody = email.text?.trim() ? email.text : bodyMarkdown;
  const verificationCode = extractVerificationCode(subject, plainBody);
  return { subject, header, plainBody, verificationCode };
};

/** 调用 LLM 分析邮件并编辑 Telegram 消息（验证码 / 摘要 + 标签），返回分析结果 */
export const editMessageWithAnalysis = async (
  env: Env,
  chatId: string,
  tgMessageId: number,
  header: string,
  subject: string,
  plainBody: string,
  keyboard: unknown,
  verificationCode: string | null,
): Promise<EmailAnalysis> => {
  const result = await new LLMClient(env).analyzeEmail(subject, plainBody);

  // 高置信度垃圾邮件仅添加 Junk 标签，不移动到垃圾箱
  if (
    result.isJunk &&
    result.junkConfidence >= 0.8 &&
    !result.tags.some((tag) => /^junk$/i.test(tag))
  ) {
    result.tags.push("Junk");
  }

  const codeSection = verificationCode
    ? buildRichVerificationCodeSection(verificationCode)
    : "";
  const summaryMarkdown = truncateMarkdown(result.summary, 20_000).markdown;
  const summary = toTelegramRichHtml(
    truncateMarkdownBlocks(summaryMarkdown, 450).markdown,
  );
  const tags =
    result.tags.length > 0
      ? `<p>&#160;</p><p>${result.tags.map((tag) => `#${escapeHtmlText(truncateUnicodeText(tag.replace(/\s+/g, "_"), TG_TAG_LENGTH_LIMIT))}`).join(" ")}</p>`
      : "";
  await new TelegramClient(env).editRichMessage(
    chatId,
    tgMessageId,
    `${header}${codeSection}<p><b>${escapeHtmlText(t("bridge:aiSummary"))}</b></p>${summary}${tags}`,
    keyboard,
  );
  return result;
};
