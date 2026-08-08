import { stripHtmlTags, utf8Decoder } from "@worker/utils/string";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export type BodySource = "html" | "text" | "stripped-html" | "empty";

export interface RenderedEmailBody {
  markdown: string;
  source: BodySource;
}

export interface TruncatedMarkdown {
  markdown: string;
  truncated: boolean;
}

interface BodyQuality {
  visibleCharacters: number;
  noiseSignals: number;
}

type HtmlWindow = ReturnType<typeof parseHTML>;
type HtmlDocument = HtmlWindow["document"];
type HtmlElement = InstanceType<HtmlWindow["HTMLElement"]>;
type QueryRoot = {
  querySelectorAll: (selectors: string) => unknown;
};

const HIDDEN_STYLE_RE =
  /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\D|$))/i;
const ZERO_HEIGHT_RE = /(?:max-)?height\s*:\s*0(?:px|em|rem|%)?(?:\D|$)/i;
const HIDDEN_OVERFLOW_RE = /overflow\s*:\s*hidden/i;
const ZERO_WIDTH_RE = /[\u034f\u200b-\u200d\ufeff]/g;
const SHORT_TABLE_CELL_LENGTH = 48;
const LONG_VISIBLE_URL_LENGTH = 200;
const FOOTER_LINK_RE =
  /unsubscribe|privacy|terms?|preferences?|退订|取消订阅|隐私|条款|取消訂閱|隱私|條款/i;
const FOOTER_LEGAL_RE = /copyright|©|all rights reserved|版权所有|版權所有/i;
const DECORATIVE_BLOCK_RE = /^(?:\||¦)+$/;
const EMPTY_LINK_RE = /^\[\s*\]\([^)]*\)$/;
const DECORATIVE_IMAGE_ALT_RE =
  /^(?:badge|banner|decorative|graphic|icon|image|img|logo|photo|pixel|spacer)(?:\s+\d+)?$/i;
const ACTIONABLE_IMAGE_ALT_RE =
  /\b(?:activate|buy|claim|confirm|download|get|learn|open|order|read|redeem|register|reset|review|shop|sign\s*in|track|verify|view)\b|优惠|折扣|免费|领取|查看|下单|购买|兑换|验证|确认|立即/i;
const OFFER_IMAGE_ALT_RE =
  /\b(?:coupon|deal|discount|free|offer|off|reward|sale|save)\b|优惠|折扣|免费|奖励|促销/i;
const MIN_MEANINGFUL_IMAGE_ALT_LENGTH = 16;
const SERIALIZED_RATIO_THRESHOLD = 1.8;
const MIN_SERIALIZED_INFLATION = 300;
const MIN_FRAGMENT_BLOCKS = 12;
const SHORT_BLOCK_LENGTH = 10;
const SHORT_BLOCK_RATIO_THRESHOLD = 0.35;
const MIN_DUPLICATE_BLOCKS = 4;
const DUPLICATE_RATIO_THRESHOLD = 0.15;
const MIN_ARTIFACTS = 3;
const MIN_HTML_NOISE_SIGNALS = 2;
const COMPACT_LIST_MARKER_RE = /^([ \t]*[-+])(?=\p{L})/gmu;

/** Convert an email HTML body to normalized standard Markdown. */
export const htmlToMarkdown = (input: string): string => {
  const { document } = parseHTML(prepareHtmlSource(input));
  cleanDocument(document);
  compactFooters(document);
  normalizeTables(document);
  return normalizeMarkdown(turndown.turndown(document.body));
};

/** Select the most readable MIME body while preferring clean HTML. */
export const renderEmailBody = (
  text?: string,
  html?: string,
): RenderedEmailBody => {
  const plainMarkdown = normalizePlainText(text ?? "");
  let htmlMarkdown = "";
  let htmlRenderingFailed = false;

  if (html) {
    try {
      htmlMarkdown = htmlToMarkdown(html);
    } catch {
      htmlRenderingFailed = true;
    }
  }

  if (htmlMarkdown) {
    if (plainMarkdown && shouldPreferPlainText(htmlMarkdown, plainMarkdown)) {
      return { markdown: plainMarkdown, source: "text" };
    }
    return { markdown: htmlMarkdown, source: "html" };
  }
  if (plainMarkdown) return { markdown: plainMarkdown, source: "text" };

  const strippedHtml =
    html && htmlRenderingFailed ? normalizePlainText(stripHtmlTags(html)) : "";
  if (strippedHtml) {
    return { markdown: strippedHtml, source: "stripped-html" };
  }
  return { markdown: "", source: "empty" };
};

/** Truncate standard Markdown without counting hidden link destinations. */
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
    const blockCharacters = markdownToVisibleText(block).length;
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

const truncateOversizedBlock = (
  block: string,
  maxVisibleCharacters: number,
): string => {
  const retainedLines: string[] = [];
  let visibleCharacters = 0;
  for (const line of block.split("\n")) {
    const separatorCharacters = retainedLines.length > 0 ? 1 : 0;
    const lineCharacters = markdownToVisibleText(line).length;
    if (
      visibleCharacters + separatorCharacters + lineCharacters >
      maxVisibleCharacters
    ) {
      if (retainedLines.length === 0) {
        return markdownToVisibleText(line).slice(0, maxVisibleCharacters);
      }
      break;
    }
    retainedLines.push(line);
    visibleCharacters += separatorCharacters + lineCharacters;
  }
  return retainedLines.join("\n");
};

const decodeQuotedPrintable = (input: string): string => {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/(?:=[0-9A-Fa-f]{2})+/g, (run) => {
      const bytes = new Uint8Array(run.length / 3);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
      }
      return utf8Decoder.decode(bytes);
    });
};

const prepareHtmlSource = (input: string): string => {
  let html = input.includes("=3D") ? decodeQuotedPrintable(input) : input;
  const htmlTagIndex = html.search(/<html[\s>]/i);
  if (htmlTagIndex > 0) html = html.slice(htmlTagIndex);
  else if (htmlTagIndex < 0) html = `<html><body>${html}</body></html>`;
  return stripPreHeadNodes(html);
};

const stripPreHeadNodes = (html: string): string => {
  const htmlOpen = html.match(/<html\b[^>]*>/i);
  if (htmlOpen?.index == null) return html;
  const htmlOpenEnd = htmlOpen.index + htmlOpen[0].length;
  const headIndex = html.slice(htmlOpenEnd).search(/<head[\s>]/i);
  if (headIndex < 0) return html;
  const absoluteHeadIndex = htmlOpenEnd + headIndex;
  if (!html.slice(htmlOpenEnd, absoluteHeadIndex).trim()) return html;
  return html.slice(0, htmlOpenEnd) + html.slice(absoluteHeadIndex);
};

const cleanDocument = (document: HtmlDocument): void => {
  for (const node of selectAll(
    document,
    'head, style, script, [hidden], [aria-hidden="true"]',
  )) {
    node.remove();
  }

  for (const node of selectAll(document, "[style]")) {
    const style = node.getAttribute("style") ?? "";
    if (
      HIDDEN_STYLE_RE.test(style) ||
      (ZERO_HEIGHT_RE.test(style) && HIDDEN_OVERFLOW_RE.test(style))
    ) {
      node.remove();
    }
  }

  for (const image of selectAll(document, "img")) {
    const alt = normalizeVisibleText(image.getAttribute("alt"));
    if (!isMeaningfulImageAlt(alt)) {
      image.remove();
      continue;
    }
    image.replaceWith(document.createTextNode(alt));
  }
  for (const anchor of selectAll(document, "a")) {
    const visibleText = normalizeVisibleText(anchor.textContent);
    if (!visibleText) {
      anchor.remove();
    }
  }
  removeDuplicateRawUrlLinks(document);
  for (const anchor of selectAll(document, "a")) {
    const visibleText = normalizeVisibleText(anchor.textContent);
    shortenLongVisibleUrl(anchor, visibleText);
  }
};

const isMeaningfulImageAlt = (alt: string): boolean => {
  if (!alt || DECORATIVE_IMAGE_ALT_RE.test(alt)) return false;
  return (
    alt.length >= MIN_MEANINGFUL_IMAGE_ALT_LENGTH ||
    /\d|[%$€£¥₹]/u.test(alt) ||
    ACTIONABLE_IMAGE_ALT_RE.test(alt) ||
    OFFER_IMAGE_ALT_RE.test(alt)
  );
};

const removeDuplicateRawUrlLinks = (document: HtmlDocument): void => {
  const linksByTarget = new Map<string, HtmlElement[]>();
  for (const anchor of selectAll(document, "a")) {
    const target = (anchor.getAttribute("href") ?? "").trim();
    if (!target) continue;
    const links = linksByTarget.get(target) ?? [];
    links.push(anchor);
    linksByTarget.set(target, links);
  }

  for (const links of linksByTarget.values()) {
    const hasMeaningfulLabel = links.some(
      (anchor) => !isVisibleUrl(normalizeVisibleText(anchor.textContent)),
    );
    if (!hasMeaningfulLabel) continue;
    for (const anchor of links) {
      if (isVisibleUrl(normalizeVisibleText(anchor.textContent))) {
        anchor.remove();
      }
    }
  }
};

const isVisibleUrl = (text: string): boolean => /^https?:\/\//i.test(text);

const shortenLongVisibleUrl = (
  anchor: HtmlElement,
  visibleText: string,
): void => {
  if (visibleText.length <= LONG_VISIBLE_URL_LENGTH) return;
  if (!/^https?:\/\//i.test(visibleText)) return;
  const href = anchor.getAttribute("href") ?? "";
  try {
    const target = new URL(href);
    anchor.textContent = target.hostname;
  } catch {
    // Preserve malformed links as visible text; Turndown's caller owns fallback.
  }
};

const compactFooters = (document: HtmlDocument): void => {
  const footers = selectAll(document, "footer, [id], [class]").filter(
    isExplicitFooter,
  );
  for (const footer of footers.reverse()) {
    const retainedLinks = selectAll(footer, "a").filter((anchor) =>
      FOOTER_LINK_RE.test(normalizeVisibleText(anchor.textContent)),
    );
    const legalLine = findFooterLegalLine(footer);
    if (retainedLinks.length === 0 && !legalLine) continue;

    const compactFooter = document.createElement("div");
    compactFooter.setAttribute("data-mail-compact-footer", "true");
    if (retainedLinks.length > 0) {
      const linksLine = document.createElement("div");
      linksLine.setAttribute("data-mail-footer-links", "true");
      retainedLinks.forEach((anchor, index) => {
        if (index > 0) linksLine.appendChild(document.createTextNode(" · "));
        linksLine.appendChild(anchor);
      });
      compactFooter.appendChild(linksLine);
    }
    if (legalLine) {
      const legal = document.createElement("div");
      legal.setAttribute("data-mail-footer-legal", "true");
      legal.textContent = legalLine;
      compactFooter.appendChild(legal);
    }
    footer.replaceWith(compactFooter);
  }
};

const isExplicitFooter = (element: HtmlElement): boolean => {
  if (element.tagName === "FOOTER") return true;
  const marker = `${element.getAttribute("id") ?? ""} ${
    element.getAttribute("class") ?? ""
  }`;
  return /footer/i.test(marker);
};

const findFooterLegalLine = (footer: HtmlElement): string => {
  const candidates = selectAll(footer, "p, div, span").filter((node) => {
    const text = normalizeVisibleText(node.textContent);
    if (!FOOTER_LEGAL_RE.test(text)) return false;
    return !selectAll(node, "p, div, span").some((child) =>
      FOOTER_LEGAL_RE.test(normalizeVisibleText(child.textContent)),
    );
  });
  return normalizeVisibleText(candidates[0]?.textContent ?? "");
};

const normalizeTables = (document: HtmlDocument): void => {
  const tables = selectAll(document, "table").reverse();
  for (const table of tables) {
    const container = document.createElement("div");
    container.setAttribute("data-mail-layout-table", "true");
    const rows = selectAll(table, "tr").filter(
      (row) => row.closest("table") === table,
    );
    const rowCellGroups = rows.map((row) =>
      (Array.from(row.children) as HtmlElement[]).filter((child) =>
        /^(?:TD|TH)$/.test(child.tagName),
      ),
    );
    const orphanCells = (Array.from(table.children) as HtmlElement[]).filter(
      (child) => /^(?:TD|TH)$/.test(child.tagName),
    );
    if (orphanCells.length > 0) rowCellGroups.unshift(orphanCells);

    for (const rowCells of rowCellGroups) {
      const nonEmptyCells = rowCells.filter((cell) =>
        Boolean(normalizeVisibleText(cell.textContent)),
      );
      if (nonEmptyCells.length === 0) continue;

      const normalizedRow = document.createElement("div");
      normalizedRow.setAttribute("data-mail-layout-row", "true");
      if (isShortTextPair(nonEmptyCells)) {
        const hasLabelTerminator = /[:：]\s*$/.test(
          normalizeVisibleText(nonEmptyCells[0].textContent),
        );
        if (hasLabelTerminator) flattenPairCellBlocks(nonEmptyCells);
        while (nonEmptyCells[0].firstChild) {
          normalizedRow.appendChild(nonEmptyCells[0].firstChild);
        }
        normalizedRow.appendChild(
          document.createTextNode(hasLabelTerminator ? " " : ": "),
        );
        while (nonEmptyCells[1].firstChild) {
          normalizedRow.appendChild(nonEmptyCells[1].firstChild);
        }
      } else {
        nonEmptyCells.forEach((cell, index) => {
          if (index > 0) {
            normalizedRow.appendChild(document.createTextNode(" · "));
          }
          while (cell.firstChild) normalizedRow.appendChild(cell.firstChild);
        });
      }
      container.appendChild(normalizedRow);
    }

    table.replaceWith(container);
  }
};

const isShortTextPair = (cells: HtmlElement[]): boolean => {
  if (cells.length !== 2) return false;
  if (
    !cells.every(
      (cell) =>
        normalizeVisibleText(cell.textContent).length <=
        SHORT_TABLE_CELL_LENGTH,
    )
  ) {
    return false;
  }
  if (/[:：]\s*$/.test(normalizeVisibleText(cells[0].textContent))) {
    return true;
  }
  return cells.every(
    (cell) => !cell.querySelector("blockquote, div, ol, p, pre, table, ul"),
  );
};

const flattenPairCellBlocks = (cells: HtmlElement[]): void => {
  for (const cell of cells) {
    for (const block of selectAll(cell, "div, h1, h2, h3, h4, h5, h6, p")) {
      const parent = block.parentNode;
      if (!parent) continue;
      while (block.firstChild) parent.insertBefore(block.firstChild, block);
      block.remove();
    }
  }
};

const selectAll = (root: QueryRoot, selector: string): HtmlElement[] => {
  return Array.from(root.querySelectorAll(selector) as Iterable<HtmlElement>);
};

const normalizeVisibleText = (text: string | null): string => {
  return (text ?? "")
    .replace(ZERO_WIDTH_RE, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const normalizeMarkdown = (markdown: string): string => {
  const normalized = markdown
    .replace(ZERO_WIDTH_RE, "")
    .replace(/\u00a0/g, " ")
    .replace(COMPACT_LIST_MARKER_RE, "$1 ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const retainedBlocks: string[] = [];
  for (const rawBlock of normalized.split(/\n\s*\n/)) {
    const block = rawBlock.trim();
    if (
      !block ||
      DECORATIVE_BLOCK_RE.test(block) ||
      EMPTY_LINK_RE.test(block)
    ) {
      continue;
    }
    if (block === retainedBlocks[retainedBlocks.length - 1]) continue;
    retainedBlocks.push(block);
  }
  return retainedBlocks.join("\n\n");
};

const normalizePlainText = (text: string): string => {
  const linkedText = text.replace(/https?:\/\/[^\s<>]+/gi, (url) => {
    if (url.length <= LONG_VISIBLE_URL_LENGTH) return url;
    try {
      return `[${new URL(url).hostname}](${url})`;
    } catch {
      return url;
    }
  });
  return normalizeMarkdown(linkedText);
};

const shouldPreferPlainText = (
  htmlMarkdown: string,
  plainMarkdown: string,
): boolean => {
  const htmlQuality = measureBodyQuality(htmlMarkdown);
  const plainQuality = measureBodyQuality(plainMarkdown);
  const requiredPlainCharacters = Math.min(
    80,
    Math.max(20, htmlQuality.visibleCharacters * 0.2),
  );
  return (
    htmlQuality.noiseSignals >= MIN_HTML_NOISE_SIGNALS &&
    plainQuality.noiseSignals < htmlQuality.noiseSignals &&
    plainMarkdown.length <= htmlMarkdown.length &&
    plainQuality.visibleCharacters >= requiredPlainCharacters
  );
};

const measureBodyQuality = (markdown: string): BodyQuality => {
  const visibleText = markdownToVisibleText(markdown);
  const blocks = markdown
    .split(/\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
  const normalizedBlocks = blocks.map(markdownToVisibleText);
  const frequencies = new Map<string, number>();
  for (const block of normalizedBlocks) {
    frequencies.set(block, (frequencies.get(block) ?? 0) + 1);
  }
  const duplicateBlocks = Array.from(frequencies.values()).reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  const shortBlocks = normalizedBlocks.filter(
    (block) => block.length <= SHORT_BLOCK_LENGTH,
  ).length;
  const artifacts = blocks.filter(
    (block) =>
      DECORATIVE_BLOCK_RE.test(block) ||
      EMPTY_LINK_RE.test(block) ||
      (/^https?:\/\//i.test(block) && block.length > LONG_VISIBLE_URL_LENGTH),
  ).length;

  let noiseSignals = 0;
  if (
    markdown.length >= visibleText.length * SERIALIZED_RATIO_THRESHOLD &&
    markdown.length - visibleText.length >= MIN_SERIALIZED_INFLATION
  ) {
    noiseSignals++;
  }
  if (
    blocks.length >= MIN_FRAGMENT_BLOCKS &&
    shortBlocks / blocks.length > SHORT_BLOCK_RATIO_THRESHOLD
  ) {
    noiseSignals++;
  }
  if (
    duplicateBlocks >= MIN_DUPLICATE_BLOCKS &&
    duplicateBlocks / blocks.length > DUPLICATE_RATIO_THRESHOLD
  ) {
    noiseSignals++;
  }
  if (artifacts >= MIN_ARTIFACTS) noiseSignals++;

  return { visibleCharacters: visibleText.length, noiseSignals };
};

const markdownToVisibleText = (markdown: string): string => {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-+*]|\d+\.)\s+/gm, "")
    .replace(/[*_~`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
  strongDelimiter: "**",
});

turndown.addRule("mailLayoutRow", {
  filter: (node) =>
    node.nodeName === "DIV" &&
    node.getAttribute("data-mail-layout-row") === "true",
  replacement: (content) => `${content.trim().replace(/\n{2,}/g, "\n")}\n`,
});

turndown.addRule("mailLayoutTable", {
  filter: (node) =>
    node.nodeName === "DIV" &&
    node.getAttribute("data-mail-layout-table") === "true",
  replacement: (content) => `\n\n${content.trim()}\n\n`,
});

turndown.addRule("mailFooterLinks", {
  filter: (node) =>
    node.nodeName === "DIV" &&
    node.getAttribute("data-mail-footer-links") === "true",
  replacement: (content) => content.trim(),
});

turndown.addRule("mailFooterLegal", {
  filter: (node) =>
    node.nodeName === "DIV" &&
    node.getAttribute("data-mail-footer-legal") === "true",
  replacement: (content) => `\n${content.trim()}`,
});

turndown.addRule("mailCompactFooter", {
  filter: (node) =>
    node.nodeName === "DIV" &&
    node.getAttribute("data-mail-compact-footer") === "true",
  replacement: (content) => `\n\n${content.trim()}\n\n`,
});

turndown.addRule("stripImages", {
  filter: "img",
  replacement: () => "",
});
