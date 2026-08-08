# Email Markdown Rendering Design

## Goal

Improve the readability of email bodies rendered as Telegram MarkdownV2. Remove
layout-generated blank lines, hidden preheaders, decorative links, repeated
content, and oversized tracking URLs while preserving meaningful mail content
and actions. Keep the implementation deterministic, local, inexpensive, and
shared by Telegram delivery, the preview API, and MCP HTML conversion.

## Constraints

- Do not call an LLM or add a runtime dependency for body cleanup.
- Do not add sender-, brand-, or account-specific rules.
- Keep meaningful text links such as order, verification, primary CTA,
  unsubscribe, privacy, and terms links.
- Preserve meaningful promotional and action text stored only in image `alt`
  attributes. Remove decorative image-only links, social/app badges, and bare
  tracking URLs when they duplicate a meaningful action.
- Prefer HTML, falling back to `text/plain` only when HTML is demonstrably
  noisier.
- Do not store real email content in the repository. Regression fixtures must
  be synthetic and anonymized.
- Preserve the current empty-body and plain-text fallbacks.

## Observed failure modes

The investigation sampled 21 recent inbox messages and replayed nine
representative raw MIME messages through the current repository code. Most
HTML results had roughly 45–50% blank lines, and seven of nine exceeded the
Telegram body budget before useful content was fully represented. The causes
were structural rather than MIME parsing failures:

- layout-table cells became independent Markdown paragraphs;
- hidden preheaders and zero-width filler survived;
- full tracking destinations dominated serialized Markdown length;
- image/social/app links and footer navigation survived as noise;
- repeated product or article blocks appeared more than once;
- the existing `\n{3,}` replacement could not remove alternating content and
  single blank lines;
- HTML was always preferred even when the MIME `text/plain` alternative was
  substantially cleaner.

## Architecture

Move HTML-specific rendering into a focused mail utility. It owns quoted-
printable recovery, DOM parsing and cleanup, Turndown rules, Markdown
normalization, and body-quality measurements. The existing body formatter owns
candidate selection, MarkdownV2 conversion, and bounded output.

The data flow is:

1. Receive MIME-parsed `html` and `text` alternatives.
2. Produce a normalized HTML-derived Markdown candidate and its quality
   measurements.
3. Produce a normalized plain-text candidate and the same measurements.
4. Prefer HTML unless the deterministic fallback criteria select plain text.
5. Truncate the selected standard Markdown at a complete block boundary.
6. Convert it to Telegram MarkdownV2 and run the existing validity check.

The preview API and MCP HTML conversion use the same HTML renderer. They do
not perform MIME alternative selection because they receive only HTML.

## DOM cleanup

Before Turndown:

- remove `head`, `style`, `script`, and nodes explicitly hidden by `hidden`,
  `aria-hidden=true`, or inline `display:none`, `visibility:hidden`,
  `opacity:0`, or zero-height/overflow preheader styles;
- remove zero-width filler and invisible preheader padding;
- replace images carrying meaningful promotional or action `alt` text with
  that text, preserving a surrounding action link; remove logos, tracking
  pixels, spacers, badges, and other decorative image-only anchors;
- unwrap presentation/layout containers while preserving visible descendant
  text in DOM reading order;
- normalize table rows into compact logical rows instead of allowing each
  cell to become an independent paragraph;
- compact an explicit footer container or an unambiguous unsubscribe/privacy
  link cluster, retaining the meaningful legal links and at most one short
  copyright/legal line;
- never delete all trailing content solely because it contains a footer-like
  word or appears near the end of the message.

Table rows with two short non-empty cells render as `label: value`. Other rows
join non-empty cells with a compact separator while preserving anchors and
inline emphasis inside the cells. Nested/presentation tables are flattened in
reading order. Malformed email tables that place `td`/`th` directly under a
`table` are treated as one logical row instead of being discarded. Telegram
pipe tables are not generated.

## Link handling

- Preserve an anchor when it has non-empty, meaningful visible text.
- Remove empty and decorative image-only anchors; retain a meaningful image
  `alt` label as the anchor text.
- Preserve normal short URLs when the URL itself is intentional visible text.
- When visible text is a long tracking URL, remove a duplicate fallback URL;
  if it is the only actionable destination, use its hostname as display text
  and retain the original target.
- In an explicit footer, retain unsubscribe, privacy, terms, account
  preference, and required legal links. Remove repeated navigation, social,
  and app-download clusters.
- Do not rewrite or remove query parameters from a retained target because
  opaque parameters may be required for the link to work.

## Markdown normalization

After Turndown:

- remove zero-width/control filler and normalize non-breaking whitespace;
- trim trailing spaces and blank lines;
- use soft line breaks between layout-derived rows and preserve a single blank
  line only between genuine paragraphs or sections;
- normalize unordered-list markers to `- `;
- remove standalone pipe/separator artifacts and empty links;
- remove exact adjacent duplicates and exact duplicates separated only by one
  small decorative block; do not globally deduplicate arbitrary repeated text.

## HTML versus plain-text selection

HTML remains the default. Plain text may be selected only when it is non-empty,
has sufficient meaningful content, has fewer noise signals, and HTML triggers
at least two of these independent signals after cleanup:

- serialized inflation: Markdown is at least 1.8 times its visible text length
  with at least 300 excess characters attributable to link syntax;
- fragmentation: at least 12 blocks exist and more than 35% contain ten or
  fewer visible characters;
- duplication: at least four repeated blocks exist and repeats exceed 15% of
  non-empty blocks;
- artifacts: at least three standalone separators, empty links, or visible
  URLs longer than 200 characters remain.

The plain candidate must not be longer than the cleaned HTML candidate and
must contain at least
`min(80, max(20, 20% of HTML visible characters))` visible characters. If the
scores are tied or the evidence is incomplete, HTML wins. The thresholds live
as named constants beside the selector and are covered by focused tests; this
is not a configurable scoring framework.

## Truncation and failure handling

Truncate standard Markdown before MarkdownV2 conversion. Count visible link
text rather than destination bytes, add only complete paragraphs/list items,
and never split a link or formatting span. Append the existing truncation hint
when one or more blocks are omitted. Run the existing MarkdownV2 validity
check after conversion as a final guard.

Fallback order:

1. If HTML rendering throws or produces no visible content, use normalized
   plain text.
2. If plain text is unavailable, minimally strip tags from the original HTML.
3. If MarkdownV2 validation fails, use escaped plain visible text.
4. If every source is empty, return the existing empty-body message.

Diagnostics may contain the selected source, reason codes, and numeric quality
measurements. They must not include body text, addresses, subjects, or URLs.

## Testing

Add focused tests built only from synthetic HTML and text fixtures for:

- hidden preheaders, zero-width filler, scripts, and malformed HTML;
- presentation and nested layout tables without cell-by-cell blank lines;
- compact two-column data rows;
- image-only, meaningful CTA, short visible, long tracking, and footer links;
- social/app footer clusters and balanced legal-footer retention;
- list normalization, standalone separators, and conservative near-duplicate
  removal;
- HTML-default selection, noisy-HTML plain fallback, tied scores, and
  insufficient plain-text content;
- block-boundary truncation that never cuts a link or formatting span;
- HTML failure, plain-text failure, and empty-body fallbacks;
- valid final Telegram MarkdownV2 output.

Existing email delivery, preview, MCP, and MarkdownV2 tests must remain green.
Before handoff run the focused Worker tests, the full Worker test suite,
`bun check`, and `bun typecheck`.
