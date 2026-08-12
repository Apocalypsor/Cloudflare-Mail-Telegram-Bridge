import { markdownToMdV2 } from "@worker/utils/markdown-v2";
import { escapeHtmlText } from "@worker/utils/string";
import type { Address } from "postal-mime";

/** 标准 Markdown → Telegram MarkdownV2 */
export const toTelegramMdV2 = (markdown: string): string => {
  if (!markdown) return "";
  return markdownToMdV2(markdown).trimEnd();
};

/** 标准 Markdown → Telegram Rich HTML。 */
export const toTelegramRichHtml = (markdown: string): string => {
  if (!markdown) return "";
  return renderRichMarkdown(markdown);
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

const renderRichMarkdown = (markdown: string): string => {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = /^(`{3,})(.*)$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith(fence[1])) {
        code.push(lines[index]);
        index++;
      }
      if (index < lines.length) index++;
      const language = fence[2].trim().replace(/[^A-Za-z0-9_-]/g, "");
      const className = language ? ` class="language-${language}"` : "";
      blocks.push(
        `<pre><code${className}>${escapeHtmlText(code.join("\n"))}</code></pre>`,
      );
      continue;
    }

    if (/^(?:\s*[-*_]){3,}\s*$/.test(line)) {
      index++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderRichInline(heading[2])}</h${level}>`);
      index++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = /^>\s?(.*)$/.exec(lines[index]);
        if (!match) break;
        quoted.push(renderRichInline(match[1]));
        index++;
      }
      blocks.push(`<blockquote>${quoted.join("<br>")}</blockquote>`);
      continue;
    }

    if (/^\s*[-+*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = /^\s*[-+*]\s+(.*)$/.exec(lines[index]);
        if (!match) break;
        items.push(`<li>${renderRichInline(match[1])}</li>`);
        index++;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const ordered = /^\s*(\d+)\.\s+/.exec(line);
    if (ordered) {
      const items: string[] = [];
      const start = ordered[1] === "1" ? "" : ` start="${ordered[1]}"`;
      while (index < lines.length) {
        const match = /^\s*\d+\.\s+(.*)$/.exec(lines[index]);
        if (!match) break;
        items.push(`<li>${renderRichInline(match[1])}</li>`);
        index++;
      }
      blocks.push(`<ol${start}>${items.join("")}</ol>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim()) {
      if (paragraph.length > 0 && isRichBlockStart(lines[index])) break;
      paragraph.push(renderRichInline(lines[index]));
      index++;
    }
    blocks.push(`<p>${paragraph.join("<br>")}</p>`);
  }

  return blocks.join("");
};

const renderRichInline = (text: string): string => {
  const slots: string[] = [];
  const placeholder = (html: string): string => {
    const index = slots.push(html) - 1;
    return `\uE000${index}\uE001`;
  };
  const inline = (value: string): string => {
    let output = value;
    output = output.replace(/\\([\\`*_[\]{}()#+.!~>-])/g, (_, char: string) =>
      placeholder(escapeHtmlText(char)),
    );
    output = output.replace(/`([^`]+)`/g, (_, code: string) =>
      placeholder(`<code>${escapeHtmlText(code)}</code>`),
    );
    output = output.replace(
      /!\[([^\]]*)\]\(([^)]*)\)/g,
      (_, alt: string, href: string) => renderRichLink(alt || href, href),
    );
    output = output.replace(
      /\[([^\]]*)\]\(([^)]*)\)/g,
      (_, label: string, href: string) => renderRichLink(label, href),
    );
    output = output.replace(/\*{3}(.+?)\*{3}/g, (_, value: string) =>
      placeholder(`<b><i>${inline(value)}</i></b>`),
    );
    output = output.replace(/\*{2}(.+?)\*{2}/g, (_, value: string) =>
      placeholder(`<b>${inline(value)}</b>`),
    );
    output = output.replace(/__(.+?)__/g, (_, value: string) =>
      placeholder(`<b>${inline(value)}</b>`),
    );
    output = output.replace(
      /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
      (_, value: string) => placeholder(`<i>${inline(value)}</i>`),
    );
    output = output.replace(
      /(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,
      (_, value: string) => placeholder(`<i>${inline(value)}</i>`),
    );
    output = output.replace(/~~(.+?)~~/g, (_, value: string) =>
      placeholder(`<s>${inline(value)}</s>`),
    );
    return escapeHtmlText(output);
  };
  const renderRichLink = (label: string, href: string): string => {
    const content = inline(label);
    if (!/^(?:https?:|mailto:|tel:)/i.test(href)) {
      return placeholder(content);
    }
    const escapedHref = escapeHtmlText(href).replace(/"/g, "&quot;");
    return placeholder(`<a href="${escapedHref}">${content}</a>`);
  };

  let output = inline(text);
  let previous = "";
  while (output !== previous) {
    previous = output;
    output = output.replace(/\uE000(\d+)\uE001/g, (_, index: string) => {
      return slots[Number.parseInt(index, 10)];
    });
  }
  return output;
};

const isRichBlockStart = (line: string): boolean =>
  /^(`{3,}|#{1,6}\s+|>\s?|\s*[-+*]\s+|\s*\d+\.\s+)/.test(line) ||
  /^(?:\s*[-*_]){3,}\s*$/.test(line);
