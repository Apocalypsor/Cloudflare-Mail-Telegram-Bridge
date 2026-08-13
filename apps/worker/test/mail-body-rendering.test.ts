import { describe, expect, it, vi } from "vitest";
import type { Account } from "../src/types";
import { htmlToMarkdown, renderEmailBody } from "../src/utils/mail/render";
import {
  measureTelegramRichHtml,
  toTelegramRichHtml,
  truncateMarkdown,
  truncateMarkdownBlocks,
} from "../src/utils/mail/telegram-rich-html";
import {
  buildTelegramEmailHtml,
  editMessageWithAnalysis,
  prepareEmailContent,
} from "../src/utils/mail-delivery/format";

const { analyzeEmailMock, editRichMessageMock } = vi.hoisted(() => ({
  analyzeEmailMock: vi.fn(),
  editRichMessageMock: vi.fn(),
}));

vi.mock("@worker/clients/llm", () => ({
  LLMClient: class {
    analyzeEmail = analyzeEmailMock;
  },
}));
vi.mock("@worker/clients/telegram", () => ({
  TelegramClient: class {
    editRichMessage = editRichMessageMock;
  },
}));

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

  it("preserves meaningful image alt text while removing decorative images", () => {
    const html = `
      <p><img src="spacer.gif" alt="badge"></p>
      <p><img src="brand.png" alt="EXAMPLE PIZZA"></p>
      <p><a href="https://offers.example/redeem">
        <img src="offer.png" alt="50% off menu-priced items">
      </a></p>
      <p><a href="https://offers.example/order">
        <img src="button.png" alt="Order now">
      </a></p>`;

    expect(htmlToMarkdown(html)).toBe(
      "[50% off menu-priced items](https://offers.example/redeem)\n\n" +
        "[Order now](https://offers.example/order)",
    );
  });

  it("renders layout rows without a blank paragraph per cell", () => {
    const html = `
      <table role="presentation">
        <tr><td>Status</td><td>Shipped</td></tr>
        <tr><td>Arrival</td><td>Tomorrow</td></tr>
      </table>`;

    expect(htmlToMarkdown(html)).toBe("Status: Shipped\nArrival: Tomorrow");
  });

  it("uses soft line breaks for paragraphs nested inside layout cells", () => {
    const html = `
      <table role="presentation">
        <tr><td><p>Product title</p><p>Product details</p></td></tr>
        <tr><td><p>Next product</p></td></tr>
      </table>`;

    expect(htmlToMarkdown(html)).toBe(
      "Product title\nProduct details\nNext product",
    );
  });

  it("preserves inline links in compact key-value rows", () => {
    const html = `
      <table>
        <tr>
          <td><a href="https://orders.example/42">Order</a></td>
          <td>Ready</td>
        </tr>
      </table>`;

    expect(htmlToMarkdown(html)).toBe(
      "[Order](https://orders.example/42): Ready",
    );
  });

  it("keeps a coupon label and nested value on one line", () => {
    const html = `
      <table role="presentation">
        <td><h4>Use Code:</h4></td>
        <td>
          <table role="presentation">
            <tr><td><div>REWARD-TEST-26</div></td></tr>
          </table>
        </td>
      </table>`;

    expect(htmlToMarkdown(html)).toBe("Use Code: REWARD-TEST-26");
  });

  it("keeps genuine paragraphs separated", () => {
    expect(
      htmlToMarkdown("<p>First paragraph.</p><p>Second paragraph.</p>"),
    ).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("uses a hostname for a sole long actionable URL", () => {
    const target = `https://verify.example/action?token=${"x".repeat(240)}`;

    expect(htmlToMarkdown(`<p><a href="${target}">${target}</a></p>`)).toBe(
      `[verify.example](${target})`,
    );
  });

  it("removes a duplicate raw URL when a meaningful link has the same target", () => {
    const target = `https://verify.example/action?token=${"x".repeat(240)}`;
    const html = `
      <p><a href="${target}">Verify account</a></p>
      <p><a href="${target}">${target}</a></p>`;

    expect(htmlToMarkdown(html)).toBe(`[Verify account](${target})`);
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
      "Useful message.\n\n" +
        "[Unsubscribe](https://example.test/unsubscribe) · " +
        "[Privacy](https://example.test/privacy)\n" +
        "Copyright 2026 Example.",
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

  it("prefers clean HTML when both MIME alternatives are present", () => {
    expect(
      renderEmailBody("Plain fallback", "<p><strong>Rich body</strong></p>"),
    ).toEqual({ markdown: "**Rich body**", source: "html" });
  });

  it("uses plain text when HTML triggers independent noise signals", () => {
    const rows = Array.from(
      { length: 16 },
      (_, index) => `<tr><td>${index}</td><td>|</td></tr>`,
    ).join("");
    const links = Array.from(
      { length: 4 },
      (_, index) =>
        `<p><a href="https://track.example/${index}?token=${"x".repeat(320)}">${index}</a></p>`,
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

  it("keeps HTML when the plain alternative is more verbose", () => {
    const rows = Array.from(
      { length: 16 },
      (_, index) => `<tr><td>${index}</td><td>|</td></tr>`,
    ).join("");
    const links = Array.from(
      { length: 4 },
      (_, index) =>
        `<p><a href="https://track.example/${index}?token=${"x".repeat(320)}">${index}</a></p>`,
    ).join("");

    expect(
      renderEmailBody(
        "Readable but unnecessarily verbose. ".repeat(300),
        `<table role="presentation">${rows}</table>${links}`,
      ).source,
    ).toBe("html");
  });

  it("keeps HTML when a short plain alternative may be incomplete", () => {
    const html = `<p>${"Detailed content ".repeat(20)}</p>`;

    expect(renderEmailBody("Unsubscribe", html).source).toBe("html");
  });

  it("normalizes compact hyphen list markers", () => {
    expect(renderEmailBody("-支持邮件转发\n-保留操作链接")).toEqual({
      markdown: "- 支持邮件转发\n- 保留操作链接",
      source: "text",
    });
  });

  it("does not revive intentionally hidden HTML as a stripped fallback", () => {
    expect(
      renderEmailBody(
        undefined,
        '<div style="display:none;max-height:0;overflow:hidden">Preview only</div>',
      ),
    ).toEqual({ markdown: "", source: "empty" });
  });

  it("truncates at a complete block without charging for a link target", () => {
    const target = `https://action.example/open?token=${"x".repeat(500)}`;
    const markdown = `Intro\n\n[Open order](${target})\n\nTrailing details`;

    expect(truncateMarkdown(markdown, 18)).toEqual({
      markdown: `Intro\n\n[Open order](${target})`,
      truncated: true,
    });
  });

  it("preserves complete lines when the first block exceeds the budget", () => {
    expect(truncateMarkdown("Row one\nRow two\nRow three", 15)).toEqual({
      markdown: "Row one\nRow two",
      truncated: true,
    });
  });

  it("renders standard Markdown as escaped Telegram Rich HTML", () => {
    expect(
      toTelegramRichHtml(
        "## Offer\n\n**Save 50%** & use `CODE`\n\n[Order](https://example.com?a=1&b=2)",
      ),
    ).toBe(
      "<h2>Offer</h2><p><b>Save 50%</b> &amp; use <code>CODE</code></p>" +
        '<p><a href="https://example.com?a=1&amp;b=2">Order</a></p>',
    );
  });

  it("preserves private-use characters used internally by the renderer", () => {
    expect(toTelegramRichHtml("a\uE0000\uE001b")).toBe(
      "<p>a\uE0000\uE001b</p>",
    );
  });

  it("preserves links with balanced parentheses", () => {
    expect(toTelegramRichHtml("[Wiki](https://example.com/a_(b))")).toBe(
      '<p><a href="https://example.com/a_(b)">Wiki</a></p>',
    );
  });

  it("does not wrap a long URL already inside a Markdown link", () => {
    const target = `https://example.com/${"x".repeat(220)}`;
    expect(renderEmailBody(`[安全链接](${target})`).markdown).toBe(
      `[安全链接](${target})`,
    );
  });

  it("does not split an emoji surrogate pair while truncating", () => {
    expect(truncateMarkdown("😀x", 1)).toEqual({
      markdown: "😀",
      truncated: true,
    });
  });

  it("truncates oversized lists by complete lines to fit the block budget", () => {
    const list = Array.from(
      { length: 600 },
      (_, index) => `- Item ${index}`,
    ).join("\n");
    const truncated = truncateMarkdownBlocks(list, 450);

    expect(truncated.truncated).toBe(true);
    expect(
      measureTelegramRichHtml(toTelegramRichHtml(truncated.markdown)).blocks,
    ).toBeLessThanOrEqual(450);
    expect(truncated.markdown).toContain("- Item 0");
  });

  it("removes Markdown horizontal rules from the email body", () => {
    expect(
      toTelegramRichHtml(
        "First section\n\n---\n\nSecond section\n\n***\n\n___",
      ),
    ).toBe("<p>First section</p><p>Second section</p>");
  });

  it("shortens only the email body to fit the Rich Message text budget", () => {
    const header = "<p><b>From:</b> sender@example.com</p>";
    const code = "123456";
    const body = Array.from(
      { length: 20 },
      (_, index) => `Action ${index} ${"x".repeat(80)}`,
    ).join("\n\n");

    const result = buildTelegramEmailHtml(header, body, code, 500);

    expect(result.startsWith(`${header}<p><b>🔒 验证码:</b> <code>`)).toBe(
      true,
    );
    expect(result).toContain("</code></p><p>&#160;</p><p>Action 0");
    expect(result).toContain("Action 0");
    expect(result).not.toContain("<details><summary>邮件正文</summary>");
    expect(result).toContain("正文过长");
  });

  it("does not charge a long link target against the Rich Message text limit", () => {
    const target = `https://action.example/open?token=${"x".repeat(500)}`;
    const result = buildTelegramEmailHtml(
      "<p>Header</p>",
      `[Open order](${target})`,
      null,
      100,
    );

    expect(result).toContain(`<a href="${target}">Open order</a>`);
    expect(result).not.toContain("正文过长");
  });

  it("renders a short email body directly without a details border", () => {
    const header = "<p><b>From:</b> sender@example.com</p>";
    const body = "[Open order](https://example.com/order)";

    expect(buildTelegramEmailHtml(header, body, null, 500)).toBe(
      `${header}<p><a href="https://example.com/order">Open order</a></p>`,
    );
  });

  it("renders a long email body directly", () => {
    const result = buildTelegramEmailHtml(
      "<p>Header</p>",
      "x".repeat(801),
      null,
      2_000,
    );

    expect(result).toContain(`<p>${"x".repeat(801)}</p>`);
    expect(result).not.toContain("<details>");
    expect(result).not.toContain("正文过长");
  });

  it("caps default email messages at 4,000 visible characters", () => {
    const result = buildTelegramEmailHtml(
      "<p>Header</p>",
      "x".repeat(5_000),
      null,
    );

    expect(measureTelegramRichHtml(result).textCharacters).toBeLessThanOrEqual(
      4_000,
    );
    expect(result).toContain("正文过长");
    expect(result).not.toContain("<details>");
  });

  it("keeps the final message within Telegram's text and block limits", () => {
    const tooManyParagraphs = Array.from(
      { length: 600 },
      (_, index) => `Paragraph ${index}`,
    ).join("\n\n");
    const manyBlocks = buildTelegramEmailHtml(
      "<h6>Header</h6><hr/>",
      tooManyParagraphs,
      null,
    );
    const punctuation = buildTelegramEmailHtml(
      "<h6>Header</h6><hr/>",
      "#".repeat(40_000),
      null,
    );

    expect(measureTelegramRichHtml(manyBlocks)).toMatchObject({
      blocks: expect.any(Number),
    });
    expect(measureTelegramRichHtml(manyBlocks).blocks).toBeLessThanOrEqual(500);
    expect(
      measureTelegramRichHtml(manyBlocks).textCharacters,
    ).toBeLessThanOrEqual(32_768);
    expect(
      measureTelegramRichHtml(punctuation).textCharacters,
    ).toBeLessThanOrEqual(32_768);
    expect(punctuation).toContain("正文过长");

    const longList = buildTelegramEmailHtml(
      "<h6>Header</h6><hr/>",
      Array.from({ length: 600 }, (_, index) => `- Item ${index}`).join("\n"),
      null,
    );
    expect(measureTelegramRichHtml(longList).blocks).toBeLessThanOrEqual(500);
    expect(longList).toContain("正文过长");
  });

  it("bounds oversized header fields", () => {
    const content = prepareEmailContent(
      {
        subject: "x".repeat(40_000),
        from: { name: "Sender", address: "sender@example.com" },
        to: [{ address: "user@example.com" }],
        text: "Body",
      },
      { id: 1, chat_id: "42" } as Account,
    );
    const result = buildTelegramEmailHtml(
      content.header,
      content.bodyMarkdown,
      null,
    );

    expect(measureTelegramRichHtml(result).textCharacters).toBeLessThanOrEqual(
      32_768,
    );
    expect(content.header).toContain(
      "…</b></p><details><summary>Sender &lt;sender@example.com&gt;</summary>",
    );
  });

  it("renders a localized Telegram time and a detected verification code", () => {
    const content = prepareEmailContent(
      {
        subject: "Your verification code is 482913",
        from: { name: "Example", address: "security@example.com" },
        to: [{ address: "user@example.com" }],
        text: "Use verification code 482913 to sign in.",
      },
      {
        id: 1,
        email: "account@example.com",
        chat_id: "42",
      } as Account,
    );
    const result = buildTelegramEmailHtml(
      content.header,
      content.bodyMarkdown,
      content.verificationCode,
    );

    expect(content.verificationCode).toBe("482913");
    expect(content.header).toMatch(
      /^<p><b>Your verification code is 482913<\/b><\/p><details><summary>Example &lt;security@example.com&gt;<\/summary><p><b>[\s\S]*<\/b><\/p><\/details><p>&#160;<\/p>$/,
    );
    expect(content.header).not.toContain("<h6>");
    expect(content.header).not.toContain("<hr/>");
    expect(content.header).toContain(
      "<p><b>📤 发件人: Example &lt;security@example.com&gt;<br>📥 收件人: user@example.com<br>📧 账号: account@example.com<br>🕒 时间: ",
    );
    expect(result).toMatch(
      /🕒 时间: <tg-time unix="\d+" format="wDT">[^<]+<\/tg-time>/,
    );
    expect(result).toContain(
      "</details><p>&#160;</p><p><b>🔒 验证码:</b> <code>482913</code></p><p>&#160;</p>",
    );
    expect(result).not.toContain("邮件正文");
    expect(result.match(/<details>/g)).toHaveLength(1);
  });

  it("does not add a blank paragraph between a code and an AI summary", async () => {
    analyzeEmailMock.mockResolvedValueOnce({
      summary: "• Use the verification code to sign in",
      shortSummary: "Verification code",
      tags: ["Security"],
      isJunk: false,
      junkConfidence: 0,
    });

    await editMessageWithAnalysis(
      {} as never,
      "42",
      7,
      "<h6>Header</h6><hr/>",
      "Verification code",
      "Use code 482913",
      { inline_keyboard: [] },
      "482913",
    );

    expect(editRichMessageMock).toHaveBeenCalledWith(
      "42",
      7,
      expect.stringContaining("<code>482913</code></p><h6>🤖 AI 摘要</h6>"),
      { inline_keyboard: [] },
    );
    expect(editRichMessageMock.mock.calls[0][2]).not.toContain(
      "<code>482913</code></p><p>&#160;</p><h6>",
    );
  });

  it("bounds untrusted LLM summary blocks and tag lengths", async () => {
    analyzeEmailMock.mockResolvedValueOnce({
      summary: Array.from(
        { length: 600 },
        (_, index) => `- Summary item ${index}`,
      ).join("\n"),
      shortSummary: "Summary",
      tags: ["x".repeat(1_000)],
      isJunk: false,
      junkConfidence: 0,
    });

    await editMessageWithAnalysis(
      {} as never,
      "42",
      8,
      "<h6>Header</h6><hr/>",
      "Subject",
      "Body",
      { inline_keyboard: [] },
      null,
    );

    const html = editRichMessageMock.mock.calls.at(-1)?.[3] as string;
    expect(measureTelegramRichHtml(html).blocks).toBeLessThanOrEqual(500);
    expect(measureTelegramRichHtml(html).textCharacters).toBeLessThanOrEqual(
      32_768,
    );
    expect(html).not.toContain("x".repeat(81));
  });
});
