import { renderEmailBody } from "@worker/utils/mail/render";
import { escapeHtmlText, truncateUnicodeText } from "@worker/utils/string";
import { parseHTML } from "linkedom";

interface TruncatedMarkdown {
  markdown: string;
  truncated: boolean;
}

const RICH_BLOCK_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "pre",
  "footer",
  "hr",
  "ul",
  "ol",
  "li",
  "blockquote",
  "aside",
  "figure",
  "figcaption",
  "tg-collage",
  "tg-slideshow",
  "table",
  "tr",
  "details",
  "tg-map",
  "tg-math-block",
].join(",");

/** Convert normalized Markdown into Telegram's supported Rich HTML subset. */
export const toTelegramRichHtml = (markdown: string): string => {
  if (!markdown) return "";
  return renderRichMarkdown(markdown);
};

/** Measure the two hard limits enforced by Telegram Rich Messages. */
export const measureTelegramRichHtml = (
  html: string,
): { textCharacters: number; blocks: number } => {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  return {
    textCharacters: countUnicodeCharacters(document.body.textContent ?? ""),
    blocks: document.body.querySelectorAll(RICH_BLOCK_SELECTOR).length,
  };
};

/** Truncate Markdown without charging hidden link destinations to the budget. */
export const truncateMarkdown = (
  markdown: string,
  maxVisibleCharacters: number,
): TruncatedMarkdown => {
  const blocks = markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length === 0) return { markdown: "", truncated: false };
  if (maxVisibleCharacters <= 0) {
    return { markdown: "", truncated: true };
  }

  const retained: string[] = [];
  let visibleCharacters = 0;
  for (const block of blocks) {
    const separatorCharacters = retained.length > 0 ? 2 : 0;
    const blockCharacters = markdownVisibleText(block).length;
    if (
      visibleCharacters + separatorCharacters + blockCharacters >
      maxVisibleCharacters
    ) {
      if (retained.length === 0) {
        return {
          markdown: truncateOversizedBlock(block, maxVisibleCharacters),
          truncated: true,
        };
      }
      return { markdown: retained.join("\n\n"), truncated: true };
    }
    retained.push(block);
    visibleCharacters += separatorCharacters + blockCharacters;
  }

  return { markdown: retained.join("\n\n"), truncated: false };
};

/** Keep the largest complete Markdown prefix that fits a Rich Message block budget. */
export const truncateMarkdownBlocks = (
  markdown: string,
  maxBlocks: number,
): TruncatedMarkdown => {
  if (!markdown) return { markdown: "", truncated: false };
  if (maxBlocks <= 0) return { markdown: "", truncated: true };
  if (richMarkdownBlocks(markdown) <= maxBlocks) {
    return { markdown, truncated: false };
  }

  const blocks = markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const retainedBlockCount = findLargestFittingPrefix(
    blocks.length,
    (count) => richMarkdownBlocks(blocks.slice(0, count).join("\n\n")),
    maxBlocks,
  );
  if (retainedBlockCount > 0) {
    return {
      markdown: blocks.slice(0, retainedBlockCount).join("\n\n"),
      truncated: true,
    };
  }

  const lines = blocks[0]?.split("\n") ?? [];
  const retainedLineCount = findLargestFittingPrefix(
    lines.length,
    (count) => richMarkdownBlocks(lines.slice(0, count).join("\n")),
    maxBlocks,
  );
  return {
    markdown: lines.slice(0, retainedLineCount).join("\n"),
    truncated: true,
  };
};

/**
 * Shared email-body preview pipeline.
 *
 * Markdown is intentionally internal: raw email HTML is inconsistent and unsafe to
 * pass through, while Turndown gives cleanup, MIME selection, links and truncation
 * one canonical representation before the final Telegram Rich HTML serialization.
 */
export const renderTelegramEmailBodyHtml = (
  text: string | undefined,
  html: string | undefined,
  maxVisibleCharacters: number,
): string => {
  const rendered = renderEmailBody(text, html);
  const byCharacters = truncateMarkdown(
    rendered.markdown,
    maxVisibleCharacters,
  );
  const byBlocks = truncateMarkdownBlocks(byCharacters.markdown, 500);
  return toTelegramRichHtml(byBlocks.markdown);
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
  const placeholderStart = unusedDelimiter(text, "\uE000");
  const placeholderEnd = unusedDelimiter(text, "\uE001");
  const placeholder = (html: string): string => {
    const index = slots.push(html) - 1;
    return `${placeholderStart}${index}${placeholderEnd}`;
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
      /!\[([^\]]*)\]\(((?:\\.|[^()\\]|\([^()]*\))*)\)/g,
      (_, alt: string, href: string) => renderRichLink(alt || href, href),
    );
    output = output.replace(
      /\[([^\]]*)\]\(((?:\\.|[^()\\]|\([^()]*\))*)\)/g,
      (_, label: string, href: string) => renderRichLink(label, href),
    );
    output = output.replace(/\*{3}(.+?)\*{3}/g, (_, nested: string) =>
      placeholder(`<b><i>${inline(nested)}</i></b>`),
    );
    output = output.replace(/\*{2}(.+?)\*{2}/g, (_, nested: string) =>
      placeholder(`<b>${inline(nested)}</b>`),
    );
    output = output.replace(/__(.+?)__/g, (_, nested: string) =>
      placeholder(`<b>${inline(nested)}</b>`),
    );
    output = output.replace(
      /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
      (_, nested: string) => placeholder(`<i>${inline(nested)}</i>`),
    );
    output = output.replace(
      /(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,
      (_, nested: string) => placeholder(`<i>${inline(nested)}</i>`),
    );
    output = output.replace(/~~(.+?)~~/g, (_, nested: string) =>
      placeholder(`<s>${inline(nested)}</s>`),
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
    output = output.replace(
      new RegExp(`${placeholderStart}(\\d+)${placeholderEnd}`, "g"),
      (match, index: string) => slots[Number.parseInt(index, 10)] ?? match,
    );
  }
  return output;
};

const unusedDelimiter = (text: string, character: string): string => {
  let delimiter = character;
  while (text.includes(delimiter)) delimiter += character;
  return delimiter;
};

const isRichBlockStart = (line: string): boolean =>
  /^(`{3,}|#{1,6}\s+|>\s?|\s*[-+*]\s+|\s*\d+\.\s+)/.test(line) ||
  /^(?:\s*[-*_]){3,}\s*$/.test(line);

const truncateOversizedBlock = (
  block: string,
  maxVisibleCharacters: number,
): string => {
  const retainedLines: string[] = [];
  let visibleCharacters = 0;
  for (const line of block.split("\n")) {
    const separatorCharacters = retainedLines.length > 0 ? 1 : 0;
    const lineCharacters = markdownVisibleText(line).length;
    if (
      visibleCharacters + separatorCharacters + lineCharacters >
      maxVisibleCharacters
    ) {
      if (retainedLines.length === 0) {
        return truncateUnicodeText(
          markdownVisibleText(line),
          maxVisibleCharacters,
        );
      }
      break;
    }
    retainedLines.push(line);
    visibleCharacters += separatorCharacters + lineCharacters;
  }
  return retainedLines.join("\n");
};

const markdownVisibleText = (markdown: string): string => {
  const { document } = parseHTML(
    `<html><body>${toTelegramRichHtml(markdown)}</body></html>`,
  );
  return document.body.textContent ?? "";
};

const richMarkdownBlocks = (markdown: string): number =>
  measureTelegramRichHtml(toTelegramRichHtml(markdown)).blocks;

const findLargestFittingPrefix = (
  length: number,
  measure: (prefixLength: number) => number,
  limit: number,
): number => {
  let low = 0;
  let high = length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (measure(middle) <= limit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
};

const countUnicodeCharacters = (value: string): number => [...value].length;
