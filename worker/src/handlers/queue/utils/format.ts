import { analyzeEmail, type EmailAnalysis } from "@worker/clients/llm";
import {
  editMessageCaption,
  editTextMessage,
  TG_CAPTION_LIMIT,
  TG_MSG_LIMIT,
} from "@worker/clients/telegram";
import { MESSAGE_DATE_LOCALE, MESSAGE_DATE_TIMEZONE } from "@worker/constants";
import { t } from "@worker/i18n";
import type { Account, Env } from "@worker/types";
import {
  formatBody,
  htmlToMarkdown,
  toTelegramMdV2,
} from "@worker/utils/format";
import { escapeMdV2, wrapExpandableQuote } from "@worker/utils/markdown-v2";

/**
 * 邮件 → Telegram 消息的格式化层 —— deliver / retry 共用。
 * 纯计算 + 一个 LLM-edit side effect，不读 D1 / KV，不下结论性写入；
 * 调用方负责拼装、写 mapping、维护 keyboard。
 */

function getEmailPlainBody(email: { text?: string; html?: string }): string {
  if (email.text?.trim()) return email.text;
  if (email.html) {
    try {
      return htmlToMarkdown(email.html);
    } catch {
      return "";
    }
  }
  return "";
}

function buildTelegramHeader(
  fromName: string,
  fromAddress: string,
  recipient: string,
  subject: string,
  accountEmail?: string,
): string {
  const date = new Date().toLocaleString(MESSAGE_DATE_LOCALE, {
    timeZone: MESSAGE_DATE_TIMEZONE,
  });
  const lines = [
    `*${t("bridge:header.from")}*  ${escapeMdV2(`${fromName} <${fromAddress}>`)}`,
    `*${t("bridge:header.to")}*  ${escapeMdV2(recipient)}`,
  ];
  if (accountEmail && accountEmail.toLowerCase() !== recipient.toLowerCase()) {
    lines.push(`*${t("bridge:header.account")}*  ${escapeMdV2(accountEmail)}`);
  }
  lines.push(
    `*${t("bridge:header.time")}*  ${escapeMdV2(date)}`,
    `*${t("bridge:header.subject")}*  ${escapeMdV2(subject)}`,
    ``,
    ``,
  );
  return lines.join("\n");
}

/** 从解析后的邮件中提取 TG 消息所需的各项内容（subject / header / 渲染好的正文 / LLM 用的纯文本） */
export function prepareEmailContent(
  email: {
    subject?: string;
    to?: { address?: string }[];
    from?: { name?: string; address?: string };
    text?: string;
    html?: string;
  },
  account: Account,
  isCaption: boolean,
) {
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
  const charLimit = isCaption ? TG_CAPTION_LIMIT : TG_MSG_LIMIT;
  const bodyBudget = Math.max(
    Math.floor((charLimit - header.length) * 0.9),
    100,
  );
  const formattedBody = formatBody(email.text, email.html, bodyBudget);
  const plainBody = getEmailPlainBody(email);
  return { subject, header, formattedBody, plainBody };
}

/** 调用 LLM 分析邮件并编辑 Telegram 消息（验证码 / 摘要 + 标签），返回分析结果 */
export async function editMessageWithAnalysis(
  env: Env,
  tgToken: string,
  chatId: string,
  tgMessageId: number,
  isCaption: boolean,
  header: string,
  subject: string,
  plainBody: string,
  formattedBody: string,
  keyboard: unknown,
): Promise<EmailAnalysis> {
  const editMsg = (newText: string) =>
    isCaption
      ? editMessageCaption(tgToken, chatId, tgMessageId, newText, keyboard)
      : editTextMessage(tgToken, chatId, tgMessageId, newText, keyboard);

  const result = await analyzeEmail(
    env.LLM_API_URL as string,
    env.LLM_API_KEY as string,
    env.LLM_MODEL as string,
    subject,
    plainBody,
  );

  // 高置信度垃圾邮件仅添加 Junk 标签，不移动到垃圾箱
  if (
    result.isJunk &&
    result.junkConfidence >= 0.8 &&
    !result.tags.some((tag) => /^junk$/i.test(tag))
  ) {
    result.tags.push("Junk");
  }

  const tagsLine =
    result.tags.length > 0
      ? `\n\n${result.tags.map((tag: string) => `\\#${escapeMdV2(tag.replace(/\s+/g, "_"))}`).join("  ")}`
      : "";

  if (result.verificationCode && formattedBody) {
    const codeSection = `*${t("bridge:verificationCode")}*  \`${escapeMdV2(result.verificationCode)}\`\n\n`;
    await editMsg(
      header + codeSection + wrapExpandableQuote(formattedBody) + tagsLine,
    );
    console.log("Verification code extracted");
    return result;
  }

  const summarySection = `*${escapeMdV2(t("bridge:aiSummary"))}*\n\n${toTelegramMdV2(result.summary)}`;
  await editMsg(header + summarySection + tagsLine);
  return result;
}
