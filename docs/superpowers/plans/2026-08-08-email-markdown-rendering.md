# Email Markdown Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render MIME email bodies as compact, readable Telegram MarkdownV2 without layout-table blank lines, hidden preheaders, decorative links, repeated footer noise, or premature truncation from tracking URLs.

**Architecture:** Add a focused standard-Markdown rendering module that cleans HTML, measures HTML and plain-text candidates, selects the readable candidate, and truncates complete Markdown blocks. Keep `body.ts` responsible for Telegram MarkdownV2 conversion and existing address/date helpers, and route preview/MCP HTML conversion through the shared renderer.

**Tech Stack:** TypeScript, Cloudflare Workers, linkedom, Turndown, Vitest with `@cloudflare/vitest-pool-workers`, Bun.

## Global Constraints

- Do not call an LLM or add a runtime dependency for body cleanup.
- Do not add sender-, brand-, or account-specific rules.
- Keep meaningful text links; remove empty/image-only and duplicate decorative links.
- Prefer HTML and select `text/plain` only when at least two documented HTML-noise signals fire.
- Do not put real email content in source control; every fixture is synthetic.
- Use arrow functions for standalone functions and keep module-level types immediately after imports.
- Do not add a re-export-only barrel module.
- Do not commit during this implementation unless the user explicitly asks.

---

### Task 1: Extract and harden the HTML-to-Markdown renderer

**Files:**
- Create: `apps/worker/src/utils/mail/render.ts`
- Create: `apps/worker/test/mail-body-rendering.test.ts`
- Modify: `apps/worker/src/utils/mail/body.ts:1-62,152-166`

**Interfaces:**
- Produces: `htmlToMarkdown(html: string): string`
- Produces internally: DOM cleanup helpers for hidden content, image-only anchors, zero-width filler, and table rows.
- Consumes: existing `utf8Decoder`, linkedom `parseHTML`, and Turndown.

- [ ] **Step 1: Write failing renderer tests**

Add these synthetic cases to `mail-body-rendering.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/utils/mail/render";

describe("email HTML rendering", () => {
  it("removes hidden preheaders, zero-width filler, and image-only links", () => {
    const html = `
      <html><body>
        <div style="display:none;max-height:0;overflow:hidden">Preview secret</div>
        <span>&#8203;&#8203;</span>
        <a href="https://tracker.example/pixel"><img src="pixel.gif" alt="badge"></a>
        <p>Your order is ready.</p>
      </body></html>`;

    expect(htmlToMarkdown(html)).toBe("Your order is ready.");
  });

  it("renders layout rows without a blank paragraph per cell", () => {
    const html = `
      <table role="presentation">
        <tr><td>Status</td><td>Shipped</td></tr>
        <tr><td>Arrival</td><td>Tomorrow</td></tr>
      </table>`;

    expect(htmlToMarkdown(html)).toBe("Status: Shipped\nArrival: Tomorrow");
  });

  it("keeps genuine paragraphs separated", () => {
    expect(htmlToMarkdown("<p>First paragraph.</p><p>Second paragraph.</p>"))
      .toBe("First paragraph.\n\nSecond paragraph.");
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the extraction is missing**

Run: `bun --filter telemail-worker test -- mail-body-rendering.test.ts`

Expected: FAIL because `../src/utils/mail/render` does not exist.

- [ ] **Step 3: Move the existing conversion foundation into `render.ts`**

Create the focused module with the existing quoted-printable recovery and
pre-head workaround, then preprocess the DOM before Turndown:

```ts
import { utf8Decoder } from "@worker/utils/string";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export const htmlToMarkdown = (input: string): string => {
  const html = prepareHtmlSource(input);
  const { document } = parseHTML(html);
  cleanDocument(document);
  normalizeTables(document);
  return normalizeMarkdown(turndown.turndown(document.body));
};
```

Implement `cleanDocument` so it removes `head, style, script`, `[hidden]`,
`[aria-hidden="true"]`, inline hidden/preheader styles, images, and anchors that
have no visible text after their images are removed. Decode HTML zero-width
entities through the DOM, then remove Unicode `U+200B`–`U+200D`, `U+034F`, and
`U+FEFF` during Markdown normalization.

Implement `normalizeTables` before Turndown. Process innermost tables first and
replace structural `table`/`tr`/`td` wrappers with marked `div` rows while
moving, rather than copying, each cell's child nodes. This preserves anchors
and inline emphasis. Two short text-only cells become `label: value`; other
non-empty cells retain their original child nodes and use ` · ` separators. A
custom Turndown rule renders marked rows with a single newline.

- [ ] **Step 4: Remove HTML-specific implementation from `body.ts`**

Replace the linkedom/Turndown imports and old `htmlToMarkdown` implementation
with:

```ts
import {
  htmlToMarkdown,
  renderEmailBody,
  truncateMarkdown,
} from "@worker/utils/mail/render";
```

`renderEmailBody` and `truncateMarkdown` are added in Tasks 3 and 4. During
Task 1, import only `htmlToMarkdown` so the tree remains type-correct at this
checkpoint.

- [ ] **Step 5: Run the focused test and typecheck the Worker**

Run: `bun --filter telemail-worker test -- mail-body-rendering.test.ts`

Expected: PASS for the three Task 1 cases.

Run: `bun --filter telemail-worker typecheck`

Expected: PASS.

---

### Task 2: Add meaningful-link, footer, and conservative deduplication rules

**Files:**
- Modify: `apps/worker/src/utils/mail/render.ts`
- Modify: `apps/worker/test/mail-body-rendering.test.ts`

**Interfaces:**
- Consumes: `htmlToMarkdown(html: string): string` from Task 1.
- Produces: the final deterministic HTML cleanup behavior used by later candidate selection.

- [ ] **Step 1: Add failing link and footer tests**

Append synthetic cases with these exact expectations:

```ts
it("keeps meaningful text links and removes decorative links", () => {
  const html = `
    <p><a href="https://orders.example/42?token=opaque">View order</a></p>
    <p><a href="https://social.example/profile"><img src="social.png"></a></p>`;

  expect(htmlToMarkdown(html)).toBe(
    "[View order](https://orders.example/42?token=opaque)",
  );
});

it("uses a hostname for a sole long actionable URL", () => {
  const target = `https://verify.example/action?token=${"x".repeat(240)}`;
  expect(htmlToMarkdown(`<p><a href="${target}">${target}</a></p>`)).toBe(
    `[verify.example](${target})`,
  );
});

it("compacts an explicit footer but keeps required links", () => {
  const html = `
    <main><p>Useful message.</p></main>
    <footer>
      <a href="https://example.test/home">Home</a>
      <a href="https://example.test/social">Social</a>
      <a href="https://example.test/unsubscribe">Unsubscribe</a>
      <a href="https://example.test/privacy">Privacy</a>
      <p>Copyright 2026 Example.</p>
    </footer>`;

  expect(htmlToMarkdown(html)).toBe(
    "Useful message.\n\n[Unsubscribe](https://example.test/unsubscribe) · " +
      "[Privacy](https://example.test/privacy)\nCopyright 2026 Example.",
  );
});

it("removes only near-adjacent exact duplicates", () => {
  const html = `
    <p>Repeated title</p><p>|</p><p>Repeated title</p>
    <p>Keep this</p><p>Repeated title</p>`;

  expect(htmlToMarkdown(html)).toBe(
    "Repeated title\n\nKeep this\n\nRepeated title",
  );
});
```

- [ ] **Step 2: Run the focused tests and verify the new behavior fails**

Run: `bun --filter telemail-worker test -- mail-body-rendering.test.ts`

Expected: FAIL on meaningful-link normalization, footer compaction, and
near-duplicate removal.

- [ ] **Step 3: Implement link normalization**

Before Turndown, remove anchors with no visible text. For anchors whose visible
text is an HTTP(S) URL longer than 200 characters, replace the visible text
with `new URL(href).hostname` while keeping the untouched destination. If URL
parsing fails, unwrap the anchor and retain its visible text rather than
throwing.

Do not delete query parameters from retained destinations. Keep the existing
Turndown link syntax for all meaningful text anchors.

- [ ] **Step 4: Implement balanced explicit-footer compaction**

Recognize semantic `<footer>` plus containers whose `class` or `id` contains
`footer`. Within that container, retain links whose normalized text matches a
small module regex covering `unsubscribe`, `privacy`, `terms`, `preferences`,
`退订`, `取消订阅`, `隐私`, `条款`, `取消訂閱`, `隱私`, and `條款`. Join retained
links with ` · ` and retain at most one line matching `copyright`, `©`,
`all rights reserved`, `版权所有`, or `版權所有`. Remove the remaining footer
navigation. Do not compact an unmarked trailing block.

- [ ] **Step 5: Implement Markdown artifact and near-duplicate cleanup**

Split normalized Markdown into logical blocks. Drop standalone `|`, `¦`, and
empty-link blocks. Drop a block when it exactly equals the previous retained
block, or when the only block between the two is a dropped decorative block.
Never deduplicate the same text globally.

- [ ] **Step 6: Run focused tests and Worker typecheck**

Run: `bun --filter telemail-worker test -- mail-body-rendering.test.ts`

Expected: PASS for Tasks 1–2.

Run: `bun --filter telemail-worker typecheck`

Expected: PASS.

---

### Task 3: Select HTML or plain text with deterministic quality signals

**Files:**
- Modify: `apps/worker/src/utils/mail/render.ts`
- Modify: `apps/worker/test/mail-body-rendering.test.ts`

**Interfaces:**
- Produces: `BodySource = "html" | "text" | "stripped-html" | "empty"`.
- Produces: `RenderedEmailBody = { markdown: string; source: BodySource }`.
- Produces: `renderEmailBody(text?: string, html?: string): RenderedEmailBody`.
- Consumes: `htmlToMarkdown(html: string): string` from Tasks 1–2.

- [ ] **Step 1: Add failing candidate-selection tests**

```ts
import {
  htmlToMarkdown,
  renderEmailBody,
} from "../src/utils/mail/render";

it("prefers clean HTML when both MIME alternatives are present", () => {
  expect(renderEmailBody("Plain fallback", "<p><strong>Rich body</strong></p>"))
    .toEqual({ markdown: "**Rich body**", source: "html" });
});

it("uses plain text when HTML triggers independent noise signals", () => {
  const rows = Array.from(
    { length: 16 },
    (_, index) => `<tr><td>${index}</td><td>|</td></tr>`,
  ).join("");
  const links = Array.from(
    { length: 4 },
    (_, index) =>
      `<p><a href="https://track.example/${index}?token=${"x".repeat(320)}">` +
      `${index}</a></p>`,
  ).join("");

  expect(
    renderEmailBody(
      "Your package ships tomorrow. Track it from your account.",
      `<table role="presentation">${rows}</table>${links}`,
    ),
  ).toEqual({
    markdown: "Your package ships tomorrow. Track it from your account.",
    source: "text",
  });
});

it("keeps HTML when a short plain alternative may be incomplete", () => {
  const html = `<p>${"Detailed content ".repeat(20)}</p>`;
  expect(renderEmailBody("Unsubscribe", html).source).toBe("html");
});
```

- [ ] **Step 2: Run selection tests and verify they fail**

Run: `bun --filter telemail-worker test -- mail-body-rendering.test.ts`

Expected: FAIL because `renderEmailBody` is not implemented.

- [ ] **Step 3: Implement candidate measurements and selection**

Add module-level types immediately after imports:

```ts
export type BodySource = "html" | "text" | "stripped-html" | "empty";

export interface RenderedEmailBody {
  markdown: string;
  source: BodySource;
}

interface BodyQuality {
  visibleCharacters: number;
  noiseSignals: number;
}
```

Normalize plain text with the same whitespace, artifact, and near-duplicate
cleanup used for HTML Markdown. Measure the four signals from the design using
named constants: serialized ratio `1.8`, minimum inflation `300`, minimum
fragment blocks `12`, short-block ratio `0.35`, minimum duplicate blocks `4`,
duplicate ratio `0.15`, minimum artifact count `3`, and long URL length `200`.

Select text only when HTML fires at least two signals, text fires fewer, the
plain candidate is no longer than cleaned HTML, and plain visible length satisfies
`min(80, max(20, htmlVisibleCharacters * 0.2))`. Ties choose HTML. Catch HTML
rendering errors and use normalized text; if no text exists, use
`stripHtmlTags(html).trim()` as `stripped-html`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun --filter telemail-worker test -- mail-body-rendering.test.ts`

Expected: PASS for selection and prior rendering cases.

Run: `bun --filter telemail-worker typecheck`

Expected: PASS.

---

### Task 4: Truncate complete Markdown blocks and integrate all callers

**Files:**
- Modify: `apps/worker/src/utils/mail/render.ts`
- Modify: `apps/worker/src/utils/mail/body.ts:1-123`
- Modify: `apps/worker/src/utils/mail-delivery/format.ts:11-15`
- Modify: `apps/worker/src/api/modules/mcp/utils.ts:8`
- Modify: `apps/worker/test/mail-body-rendering.test.ts`

**Interfaces:**
- Produces: `truncateMarkdown(markdown: string, maxVisibleCharacters: number): { markdown: string; truncated: boolean }`.
- Consumes: `renderEmailBody(text?: string, html?: string): RenderedEmailBody`.
- Preserves: `formatBody(text, html, maxLen): string` public signature.

- [ ] **Step 1: Add failing truncation and integration tests**

```ts
import { formatBody } from "../src/utils/mail/body";
import {
  renderEmailBody,
  truncateMarkdown,
} from "../src/utils/mail/render";
import { findLongestValidMdV2Prefix } from "../src/utils/markdown-v2";

it("truncates at a complete block without charging for a link target", () => {
  const target = `https://action.example/open?token=${"x".repeat(500)}`;
  const markdown = `Intro\n\n[Open order](${target})\n\nTrailing details`;

  expect(truncateMarkdown(markdown, 18)).toEqual({
    markdown: `Intro\n\n[Open order](${target})`,
    truncated: true,
  });
});

it("returns valid MarkdownV2 after formatted-body truncation", () => {
  const result = formatBody(
    undefined,
    `<p>First complete paragraph.</p><p>${"Final details ".repeat(30)}</p>`,
    80,
  );

  expect(findLongestValidMdV2Prefix(result)).toBe(result.length);
  expect(result).toContain("正文过长");
});
```

- [ ] **Step 2: Run focused tests and verify truncation fails**

Run: `bun --filter telemail-worker test -- mail-body-rendering.test.ts`

Expected: FAIL because `truncateMarkdown` is missing and `formatBody` still
slices converted MarkdownV2 by serialized length.

- [ ] **Step 3: Implement block-aware visible-length truncation**

Split standard Markdown on blank-line block boundaries. Count visible text by
removing Markdown link destinations while retaining link labels, then removing
formatting delimiters. Append whole blocks while their visible count fits the
budget. Return the retained Markdown and `truncated: true` when any non-empty
block is omitted. If the first block alone exceeds the budget, take the
longest Markdown-safe prefix outside link destinations and formatting spans.

- [ ] **Step 4: Integrate candidate selection into `formatBody`**

Replace the current HTML-first/slice flow with:

```ts
const rendered = renderEmailBody(text, html);
if (!rendered.markdown) return escapeMdV2("（正文为空）");

const { markdown, truncated } = truncateMarkdown(rendered.markdown, maxLen);
const converted = convertTelegramMdV2Safe(markdown);
const validEnd = findLongestValidMdV2Prefix(converted);
const safeBody =
  validEnd === converted.length
    ? converted
    : escapeMdV2(stripHtmlTags(markdown));

return truncated
  ? `${safeBody}\n\n${toTelegramMdV2("*… 正文过长，已截断 …*")}`
  : safeBody;
```

Keep the existing empty-body message and final MarkdownV2 fallback.

- [ ] **Step 5: Point direct HTML consumers at the shared renderer**

In `mail-delivery/format.ts`, import `htmlToMarkdown` from
`@worker/utils/mail/render` and keep `formatBody`/`toTelegramMdV2` from
`body.ts`. In MCP utilities, import `htmlToMarkdown` from the same renderer.
The preview API already calls `formatBody` and requires no route change.

- [ ] **Step 6: Run focused tests and Worker tests**

Run: `bun --filter telemail-worker test -- mail-body-rendering.test.ts`

Expected: PASS.

Run: `bun --filter telemail-worker test`

Expected: all Worker tests PASS.

---

### Task 5: Final verification and privacy review

**Files:**
- Review: `apps/worker/src/utils/mail/render.ts`
- Review: `apps/worker/src/utils/mail/body.ts`
- Review: `apps/worker/test/mail-body-rendering.test.ts`
- Review: `docs/superpowers/specs/2026-08-08-email-markdown-rendering-design.md`

**Interfaces:**
- Verifies all public interfaces and project-wide constraints from Tasks 1–4.

- [ ] **Step 1: Scan for private sample content and sender-specific rules**

Run:

```bash
git diff -- apps/worker/src/utils/mail apps/worker/test docs/superpowers
```

Expected: only synthetic `example` domains and generic fixture text; no real
subjects, addresses, URLs, message IDs, or brand-specific branches.

- [ ] **Step 2: Run repository formatting and static checks**

Run: `bun check`

Expected: PASS without `biome-ignore`.

Run: `bun typecheck`

Expected: PASS.

- [ ] **Step 3: Run the complete Worker test suite once more**

Run: `bun --filter telemail-worker test`

Expected: all tests PASS.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only the renderer implementation, its synthetic tests, call-site
updates, and the spec/plan documents are modified or added. Leave all changes
uncommitted for user review.
