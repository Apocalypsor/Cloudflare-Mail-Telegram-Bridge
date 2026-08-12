import { escapeHtmlText } from "@worker/utils/string";
import type { Address } from "postal-mime";

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
