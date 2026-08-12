import { analyzeEmail, type EmailAnalysis } from "@worker/clients/llm";
import { editMessageCaption, editRichMessage } from "@worker/clients/telegram";
import {
  MESSAGE_DATE_LOCALE,
  MESSAGE_DATE_TIMEZONE,
  TG_RICH_TEXT_LIMIT,
} from "@worker/constants";
import { t } from "@worker/i18n";
import type { Account, Env } from "@worker/types";
import { toTelegramMdV2, toTelegramRichHtml } from "@worker/utils/mail/body";
import { renderEmailBody, truncateMarkdown } from "@worker/utils/mail/render";
import { escapeMdV2 } from "@worker/utils/markdown-v2";
import { escapeHtmlText, stripHtmlTags } from "@worker/utils/string";

const TG_RICH_BODY_AUTO_EXPAND_LIMIT = 800;

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
  markdownV2 = false,
): string => {
  const now = new Date();
  const date = now.toLocaleString(MESSAGE_DATE_LOCALE, {
    timeZone: MESSAGE_DATE_TIMEZONE,
  });
  const line = (label: string, value: string, boldValue = false) => {
    const escapedValue = markdownV2 ? escapeMdV2(value) : escapeHtmlText(value);
    const formattedValue = boldValue
      ? markdownV2
        ? `*${escapedValue}*`
        : `<b>${escapedValue}</b>`
      : escapedValue;
    return markdownV2
      ? `*${label}*  ${formattedValue}`
      : `${escapeHtmlText(label)} ${formattedValue}`;
  };
  const lines = [
    line(t("bridge:header.from"), `${fromName} <${fromAddress}>`),
    line(t("bridge:header.to"), recipient),
  ];
  if (accountEmail && accountEmail.toLowerCase() !== recipient.toLowerCase()) {
    lines.push(line(t("bridge:header.account"), accountEmail));
  }
  lines.push(
    markdownV2
      ? line(t("bridge:header.time"), date)
      : `${escapeHtmlText(t("bridge:header.time"))} <tg-time unix="${Math.floor(now.getTime() / 1_000)}" format="wDT">${escapeHtmlText(date)}</tg-time>`,
    line(t("bridge:header.subject"), subject, true),
  );
  return markdownV2
    ? `${lines.join("\n")}\n\n`
    : `<h6>${lines.join("<br>")}</h6><hr/>`;
};

const buildVerificationCodeSection = (code: string): string =>
  `*${t("bridge:verificationCode")}*  \`${escapeMdV2(code)}\`\n\n`;

const buildRichVerificationCodeSection = (code: string): string =>
  `<p><b>${escapeHtmlText(t("bridge:verificationCode"))}</b> <code>${escapeHtmlText(code)}</code></p><p>&#160;</p>`;

export const buildTelegramEmailHtml = (
  headerHtml: string,
  bodyMarkdown: string,
  verificationCode: string | null,
  maxVisibleCharacters = TG_RICH_TEXT_LIMIT,
): string => {
  const codeSection = verificationCode
    ? buildRichVerificationCodeSection(verificationCode)
    : "";
  const build = (markdown: string, truncated: boolean) => {
    const body = markdown
      ? toTelegramRichHtml(markdown)
      : "<p>（正文为空）</p>";
    const hint = truncated ? "<footer>… 正文过长，已截断 …</footer>" : "";
    if (
      !truncated &&
      stripHtmlTags(body).length <= TG_RICH_BODY_AUTO_EXPAND_LIMIT
    ) {
      return `${headerHtml}${codeSection}${body}`;
    }
    return `${headerHtml}${codeSection}<details><summary>邮件正文</summary>${body}${hint}</details>`;
  };
  const fixedCharacters = stripHtmlTags(headerHtml + codeSection).length + 32;
  const { markdown, truncated } = truncateMarkdown(
    bodyMarkdown,
    Math.max(0, maxVisibleCharacters - fixedCharacters),
  );
  return build(markdown, truncated);
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

/** 从解析后的邮件中提取 TG 消息所需的各项内容（subject / header / 渲染好的正文 / LLM 用的纯文本） */
export const prepareEmailContent = (
  email: {
    subject?: string;
    to?: { address?: string }[];
    from?: { name?: string; address?: string };
    text?: string;
    html?: string;
  },
  account: Account,
  legacyCaption = false,
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
    legacyCaption,
  );
  const bodyMarkdown = renderEmailBody(email.text, email.html).markdown;
  const plainBody = email.text?.trim() ? email.text : bodyMarkdown;
  const verificationCode = extractVerificationCode(subject, plainBody);
  return { subject, header, bodyMarkdown, plainBody, verificationCode };
};

/** 调用 LLM 分析邮件并编辑 Telegram 消息（验证码 / 摘要 + 标签），返回分析结果 */
export const editMessageWithAnalysis = async (
  env: Env,
  chatId: string,
  tgMessageId: number,
  legacyCaption: boolean,
  header: string,
  subject: string,
  plainBody: string,
  keyboard: unknown,
  verificationCode: string | null,
): Promise<EmailAnalysis> => {
  const result = await analyzeEmail(env, subject, plainBody);

  // 高置信度垃圾邮件仅添加 Junk 标签，不移动到垃圾箱
  if (
    result.isJunk &&
    result.junkConfidence >= 0.8 &&
    !result.tags.some((tag) => /^junk$/i.test(tag))
  ) {
    result.tags.push("Junk");
  }

  if (legacyCaption) {
    const tagsLine =
      result.tags.length > 0
        ? `\n\n${result.tags.map((tag: string) => `\\#${escapeMdV2(tag.replace(/\s+/g, "_"))}`).join("  ")}`
        : "";
    const summarySection = `*${escapeMdV2(t("bridge:aiSummary"))}*\n\n${toTelegramMdV2(result.summary)}`;
    const codeSection = verificationCode
      ? buildVerificationCodeSection(verificationCode)
      : "";
    await editMessageCaption(
      env,
      chatId,
      tgMessageId,
      header + codeSection + summarySection + tagsLine,
      keyboard,
    );
  } else {
    const codeSection = verificationCode
      ? buildRichVerificationCodeSection(verificationCode)
      : "";
    const summary = toTelegramRichHtml(result.summary);
    const tags =
      result.tags.length > 0
        ? `<p>&#160;</p><p>${result.tags.map((tag) => `#${escapeHtmlText(tag.replace(/\s+/g, "_"))}`).join(" ")}</p>`
        : "";
    await editRichMessage(
      env,
      chatId,
      tgMessageId,
      `${header}${codeSection}<h6>${escapeHtmlText(t("bridge:aiSummary"))}</h6>${summary}${tags}`,
      keyboard,
    );
  }
  return result;
};
