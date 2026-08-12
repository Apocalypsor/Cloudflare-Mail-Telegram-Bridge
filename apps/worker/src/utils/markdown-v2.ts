import { escapeBackslashAndBacktick } from "@worker/utils/string";

/**
 * 转义 Telegram MarkdownV2 特殊字符。
 * 参考: https://core.telegram.org/bots/api#markdownv2-style
 */
export const escapeMdV2 = (str: string): string => {
  if (!str) return "";
  return str.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
};

// ---------------------------------------------------------------------------
// Standard Markdown → Telegram MarkdownV2 converter
// ---------------------------------------------------------------------------

/** Escape content inside ` ` or ``` ``` (only ` and \ need escaping per Telegram spec). */
const escapeCode = (s: string): string => {
  return escapeBackslashAndBacktick(s);
};

/** Escape a URL inside (...) of an inline link (only ) and \ need escaping per Telegram spec). */
const escapeLinkUrl = (url: string): string => {
  return url.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
};

/**
 * Convert standard Markdown to Telegram MarkdownV2.
 * Handles: bold, italic, bold+italic, strikethrough, inline code, fenced code
 * blocks, links, images, headings, ordered & unordered lists, blockquotes,
 * and horizontal rules.
 */
export const markdownToMdV2 = (md: string): string => {
  if (!md) return "";

  // Shared placeholder slots — all recursive inline() calls share the same
  // array so that nested constructs (e.g. bold wrapping a link) resolve
  // correctly in a single final restoration pass.
  const slots: string[] = [];
  const ph = (s: string): string => {
    const idx = slots.length;
    slots.push(s);
    return `${NUL}${idx}${NUL}`;
  };

  /** Convert inline Markdown spans, storing results as placeholder slots. */
  const inline = (text: string): string => {
    let s = text;

    // 1. Inline code — protect content from further processing
    s = s.replace(/`([^`]+)`/g, (_, code: string) =>
      ph(`\`${escapeCode(code)}\``),
    );

    // 2. Images ![alt](url) → link (Telegram can't render inline images)
    s = s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_, alt: string, url: string) =>
      ph(`[${inline(alt || url)}](${escapeLinkUrl(url)})`),
    );

    // 3. Links [text](url)
    s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, t: string, u: string) =>
      ph(`[${inline(t)}](${escapeLinkUrl(u)})`),
    );

    // 4. ***: bold + italic
    s = s.replace(/\*{3}(.+?)\*{3}/g, (_, inner: string) =>
      ph(`*_${inline(inner)}_*`),
    );

    // 5. **: bold → Telegram *
    s = s.replace(/\*{2}(.+?)\*{2}/g, (_, inner: string) =>
      ph(`*${inline(inner)}*`),
    );

    // 6. __: bold (standard md) → Telegram *
    s = s.replace(/__(.+?)__/g, (_, inner: string) => ph(`*${inline(inner)}*`));

    // 7. Single *: italic → Telegram _
    s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, inner: string) =>
      ph(`_${inline(inner)}_`),
    );

    // 8. Single _: italic → Telegram _
    s = s.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, (_, inner: string) =>
      ph(`_${inline(inner)}_`),
    );

    // 9. ~~: strikethrough → Telegram ~
    s = s.replace(/~~(.+?)~~/g, (_, inner: string) => ph(`~${inline(inner)}~`));

    // 10. Escape remaining MdV2 special characters
    s = s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");

    return s;
  };

  // --- Block-level processing ---
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // --- Fenced code block ---
    const fenceMatch = line.match(/^(`{3,})(.*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      const lang = fenceMatch[2].trim();
      out.push(
        `\`\`\`${lang ? escapeCode(lang) : ""}\n${codeLines.map(escapeCode).join("\n")}\n\`\`\``,
      );
      continue;
    }

    // --- Horizontal rule (before list check since `***` could look like `*` list) ---
    if (HR_RE.test(line)) {
      out.push(escapeMdV2(line.trim()));
      i++;
      continue;
    }

    // --- Heading → bold ---
    const headingMatch = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
    if (headingMatch) {
      out.push(`*${inline(headingMatch[1])}*`);
      i++;
      continue;
    }

    // --- Blockquote ---
    const bqMatch = line.match(/^>\s?(.*)/);
    if (bqMatch) {
      out.push(bqMatch[1] ? `> ${inline(bqMatch[1])}` : ">");
      i++;
      continue;
    }

    // --- Unordered list ---
    const ulMatch = line.match(/^(\s*)[*+-]\s+(.*)/);
    if (ulMatch) {
      out.push(`${ulMatch[1]}•   ${inline(ulMatch[2])}`);
      i++;
      continue;
    }

    // --- Ordered list ---
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (olMatch) {
      out.push(`${olMatch[1]}${olMatch[2]}\\. ${inline(olMatch[3])}`);
      i++;
      continue;
    }

    // --- Normal line ---
    out.push(inline(line));
    i++;
  }

  // --- Final restoration of all placeholder slots ---
  let result = out.join("\n");
  let prev = "";
  while (result !== prev) {
    prev = result;
    result = result.replace(
      SLOT_RE,
      (_, idx: string) => slots[parseInt(idx, 10)],
    );
  }

  return result;
};

/** NUL byte used as placeholder delimiter in slot-based rendering */
const NUL = "\x00";
const SLOT_RE = new RegExp(`${NUL}(\\d+)${NUL}`, "g");

const HR_RE = /^(\*[ \t]*){3,}$|^(-[ \t]*){3,}$|^(_[ \t]*){3,}$/;
