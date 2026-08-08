import { renderEmailBody, truncateMarkdown } from "@worker/utils/mail/render";
import {
  escapeMdV2,
  findLongestValidMdV2Prefix,
  markdownToMdV2,
} from "@worker/utils/markdown-v2";
import { escapeHtmlText, stripHtmlTags } from "@worker/utils/string";
import type { Address } from "postal-mime";

/** 修复 Telegram MarkdownV2 易出错片段（例如单独一行的 "***"） */
const sanitizeTelegramMdV2 = (md: string): string => {
  return md.replace(/(^|\n)\*{3,}(?=\n|$)/g, "$1\\*\\*\\*");
};

/** 标准 Markdown → Telegram MarkdownV2 */
export const toTelegramMdV2 = (markdown: string): string => {
  if (!markdown) return "";
  return markdownToMdV2(markdown).trimEnd();
};

const convertTelegramMdV2Safe = (markdown: string): string => {
  return sanitizeTelegramMdV2(toTelegramMdV2(markdown));
};

/**
 * 处理邮件正文：优先将 HTML 转 Markdown，fallback 到纯文本，超长截断并提示。
 * @param maxLen 本次可用的最大字符数（由调用方根据其他部分占用动态计算）
 */
export const formatBody = (
  text: string | undefined,
  html: string | undefined,
  maxLen: number,
): string => {
  const rendered = renderEmailBody(text, html);
  if (!rendered.markdown) return escapeMdV2("（正文为空）");

  const { markdown, truncated } = truncateMarkdown(rendered.markdown, maxLen);
  const truncatedHint = `\n\n${toTelegramMdV2("*… 正文过长，已截断 …*")}`;
  const converted = convertTelegramMdV2Safe(markdown);
  const validEnd = findLongestValidMdV2Prefix(converted);
  const safeBody =
    validEnd === converted.length
      ? converted
      : escapeMdV2(stripHtmlTags(markdown));
  return truncated ? `${safeBody}${truncatedHint}` : safeBody;
};

// ─── 邮件正文包装 / 地址格式化 ──────────────────────────────────────────────

/** 将 PostalMime Address 格式化为可读字符串 */
export const formatAddress = (addr: Address): string => {
  if (addr.address)
    return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
  return addr.name;
};

/**
 * 邮件 Date 头的安全解析。Gmail 来的是 RFC 5322（"Wed, 29 Apr 2026 …"），IMAP /
 * Outlook 走 PostalMime 来的是 ISO 8601 —— `new Date(...)` 两种都接，但格式有时
 * 残缺，统一收成 Date | null。空 / 解析不出来 → null。
 */
export const parseEmailDate = (
  input: string | null | undefined,
): Date | null => {
  if (!input) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** 将纯文本包裹成可读的 HTML 页面 */
export const wrapPlainText = (text: string): string => {
  const escaped = escapeHtmlText(text);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:monospace;white-space:pre-wrap;word-break:break-word;max-width:800px;margin:2em auto;padding:0 1em;line-height:1.5;color:#333}</style></head><body>${escaped}</body></html>`;
};
