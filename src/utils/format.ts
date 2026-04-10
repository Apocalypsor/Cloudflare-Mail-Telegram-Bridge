import {
  escapeMdV2,
  findLongestValidMdV2Prefix,
  markdownToMdV2,
} from "@utils/markdown-v2";
import { parseHTML } from "linkedom";
import type { Address } from "postal-mime";
import TurndownService from "turndown";
import { MAX_BODY_CHARS, MAX_LINKS } from "@/constants";

/** HTML → Markdown 转换器实例（linkedom DOM + turndown） */
const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
  strongDelimiter: "**",
});

// Strip images — Telegram can't render inline images
turndown.addRule("stripImages", {
  filter: "img",
  replacement() {
    return "";
  },
});

export function htmlToMarkdown(html: string): string {
  // Fallback: decode quoted-printable if the MIME parser left it un-decoded
  if (html.includes("=3D"))
    html = html
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );

  // linkedom can't handle orphan elements between <!doctype> and <html>;
  // they cause document.body to be empty. Strip them before parsing.
  const htmlTagIdx = html.search(/<html[\s>]/i);
  if (htmlTagIdx > 0) html = html.substring(htmlTagIdx);
  else if (htmlTagIdx < 0) html = `<html><body>${html}</body></html>`;

  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("head, style, script")) {
    node.remove();
  }
  return turndown
    .turndown(document.body)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 修复 Telegram MarkdownV2 易出错片段（例如单独一行的 "***"） */
function sanitizeTelegramMdV2(md: string): string {
  return md.replace(/(^|\n)\*{3,}(?=\n|$)/g, "$1\\*\\*\\*");
}

/** 标准 Markdown → Telegram MarkdownV2 */
export function toTelegramMdV2(markdown: string): string {
  if (!markdown) return "";
  return markdownToMdV2(markdown).trimEnd();
}

function convertTelegramMdV2Safe(markdown: string): string {
  return sanitizeTelegramMdV2(toTelegramMdV2(markdown));
}

/**
 * 处理邮件正文：优先将 HTML 转 Markdown，fallback 到纯文本，超长截断并提示。
 * @param maxLen 本次可用的最大字符数（由调用方根据其他部分占用动态计算）
 */
export function formatBody(
  text: string | undefined,
  html: string | undefined,
  maxLen: number,
): string {
  let raw = "";

  if (html) {
    try {
      raw = htmlToMarkdown(html);
    } catch {
      // Turndown can throw on malformed URIs in links; fall through to plain text
      raw = "";
    }
  }

  if (!raw && text) {
    raw = text.trim();
  }

  if (!raw) return escapeMdV2("（正文为空）");

  // 残留 HTML 标签
  raw = raw.replace(/<[^>]*>/g, "");

  const truncated = raw.length > maxLen;
  const truncatedHint = `\n\n${toTelegramMdV2("*… 正文过长，已截断 …*")}`;
  const converted = convertTelegramMdV2Safe(raw);

  if (!truncated) {
    const validEnd = findLongestValidMdV2Prefix(converted);
    return validEnd === converted.length ? converted : escapeMdV2(raw);
  }

  const bounded = converted.slice(0, maxLen);
  const validEnd = findLongestValidMdV2Prefix(bounded);
  if (validEnd > 0) return `${bounded.slice(0, validEnd)}${truncatedHint}`;

  // 极端兜底：如果回退仍不安全，降级为纯文本。
  return `${escapeMdV2(raw.substring(0, maxLen))}${truncatedHint}`;
}

// ─── 邮件正文预处理（供 LLM 使用） ──────────────────────────

/** 去除裸 URL 尾部的标点，但保留平衡的括号 */
function cleanTrailingPunctuation(url: string): string {
  let u = url.replace(/[.,;:!?>]+$/, "");
  while (u.endsWith(")")) {
    const opens = (u.match(/\(/g) || []).length;
    const closes = (u.match(/\)/g) || []).length;
    if (closes > opens) u = u.slice(0, -1);
    else break;
  }
  return u;
}

/** 从文本中提取链接（Markdown 格式 + 裸链接），返回 {label, url} 数组，最多 MAX_LINKS 个 */
export function extractLinks(text: string): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g)) {
    if (links.length >= MAX_LINKS) break;
    const url = m[2];
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ label: m[1] || url, url });
    }
  }

  for (const m of text.matchAll(/(?<!\()(https?:\/\/\S+)/g)) {
    if (links.length >= MAX_LINKS) break;
    const url = cleanTrailingPunctuation(m[1]);
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ label: url, url });
    }
  }

  return links;
}

/** 去除文本中的所有超链接（Markdown 链接保留文字，裸链接直接删除） */
function stripLinks(text: string): string {
  let out = text.replace(/\[([^\]]*)\]\(https?:\/\/[^)]*\)/g, "$1");
  out = out.replace(/https?:\/\/\S+/g, "");
  return out;
}

/** 预处理邮件正文：去首尾空行 + 去链接 + 截断 */
export function prepareBody(rawBody: string): string {
  const stripped = stripLinks(rawBody)
    .replace(/^\s*\n+/, "")
    .replace(/\n+\s*$/, "");
  return stripped.length > MAX_BODY_CHARS
    ? `${stripped.slice(0, MAX_BODY_CHARS)}...`
    : stripped;
}

// ─── 邮件正文包装 / 地址格式化 ──────────────────────────────────────────────

/** 将 PostalMime Address 格式化为可读字符串 */
export function formatAddress(addr: Address): string {
  if (addr.address)
    return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
  return addr.name;
}

/** 将纯文本包裹成可读的 HTML 页面 */
export function wrapPlainText(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:monospace;white-space:pre-wrap;word-break:break-word;max-width:800px;margin:2em auto;padding:0 1em;line-height:1.5;color:#333}</style></head><body>${escaped}</body></html>`;
}
