/**
 * 转义 Telegram MarkdownV2 特殊字符。
 * 参考: https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMdV2(str: string): string {
	if (!str) return '';
	return str.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

type StyleToken = '*' | '_' | '__' | '~' | '||';
type CodeToken = '`' | '```';

type TokenState = { type: 'style'; token: StyleToken } | { type: 'code'; token: CodeToken } | { type: 'link-text' } | { type: 'link-url' };

function toggleStyle(stack: TokenState[], token: StyleToken): void {
	const top = stack[stack.length - 1];
	if (top?.type === 'style' && top.token === token) {
		stack.pop();
	} else {
		stack.push({ type: 'style', token });
	}
}

function isExpandableBlockquoteMarker(md: string, index: number, inBlockquoteLine: boolean): boolean {
	if (!inBlockquoteLine) return false;
	if (md[index] !== '|' || md[index + 1] !== '|') return false;

	for (let i = index + 2; i < md.length && md[i] !== '\n'; i++) {
		if (md[i] !== ' ' && md[i] !== '\t') return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Standard Markdown → Telegram MarkdownV2 converter
// ---------------------------------------------------------------------------

/** Escape content inside ` ` or ``` ``` (only ` and \ need escaping per Telegram spec). */
function escapeCode(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

/** Escape a URL inside (...) of an inline link (only ) and \ need escaping per Telegram spec). */
function escapeLinkUrl(url: string): string {
	return url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
}

const HR_RE = /^(\*[ \t]*){3,}$|^(-[ \t]*){3,}$|^(_[ \t]*){3,}$/;

/**
 * Convert standard Markdown to Telegram MarkdownV2.
 * Handles: bold, italic, bold+italic, strikethrough, inline code, fenced code
 * blocks, links, images, headings, ordered & unordered lists, blockquotes,
 * and horizontal rules.
 */
export function markdownToMdV2(md: string): string {
	if (!md) return '';

	// Shared placeholder slots — all recursive inline() calls share the same
	// array so that nested constructs (e.g. bold wrapping a link) resolve
	// correctly in a single final restoration pass.
	const slots: string[] = [];
	function ph(s: string): string {
		const idx = slots.length;
		slots.push(s);
		return `\x00${idx}\x00`;
	}

	/** Convert inline Markdown spans, storing results as placeholder slots. */
	function inline(text: string): string {
		let s = text;

		// 1. Inline code — protect content from further processing
		s = s.replace(/`([^`]+)`/g, (_, code: string) => ph(`\`${escapeCode(code)}\``));

		// 2. Images ![alt](url) → link (Telegram can't render inline images)
		s = s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_, alt: string, url: string) => ph(`[${inline(alt || url)}](${escapeLinkUrl(url)})`));

		// 3. Links [text](url)
		s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, t: string, u: string) => ph(`[${inline(t)}](${escapeLinkUrl(u)})`));

		// 4. ***: bold + italic
		s = s.replace(/\*{3}(.+?)\*{3}/g, (_, inner: string) => ph(`*_${inline(inner)}_*`));

		// 5. **: bold → Telegram *
		s = s.replace(/\*{2}(.+?)\*{2}/g, (_, inner: string) => ph(`*${inline(inner)}*`));

		// 6. __: bold (standard md) → Telegram *
		s = s.replace(/__(.+?)__/g, (_, inner: string) => ph(`*${inline(inner)}*`));

		// 7. Single *: italic → Telegram _
		s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, inner: string) => ph(`_${inline(inner)}_`));

		// 8. Single _: italic → Telegram _
		s = s.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, (_, inner: string) => ph(`_${inline(inner)}_`));

		// 9. ~~: strikethrough → Telegram ~
		s = s.replace(/~~(.+?)~~/g, (_, inner: string) => ph(`~${inline(inner)}~`));

		// 10. Escape remaining MdV2 special characters
		s = s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

		return s;
	}

	// --- Block-level processing ---
	const lines = md.split('\n');
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
			out.push(`\`\`\`${lang ? escapeCode(lang) : ''}\n${codeLines.map(escapeCode).join('\n')}\n\`\`\``);
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
			out.push(bqMatch[1] ? `> ${inline(bqMatch[1])}` : '>');
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
	let result = out.join('\n');
	let prev = '';
	while (result !== prev) {
		prev = result;
		result = result.replace(/\x00(\d+)\x00/g, (_, idx: string) => slots[parseInt(idx)]);
	}

	return result;
}

// ---------------------------------------------------------------------------
// MdV2 validation
// ---------------------------------------------------------------------------

/**
 * 线性扫描 Telegram MarkdownV2 文本，返回"最长合法前缀"终点下标。
 * 目标覆盖 Bot API MarkdownV2 语法中的主要实体闭合规则：
 * *, _, __, ~, ||, `code`, ```pre```, [text](url), ![emoji](tg://emoji?id=...).
 */
export function findLongestValidMdV2Prefix(md: string): number {
	const stack: TokenState[] = [];
	let escaped = false;
	let longestValidEnd = 0;
	let lineStart = true;
	let inBlockquoteLine = false;
	let i = 0;

	while (i < md.length) {
		const ch = md[i];
		const top = stack[stack.length - 1];

		if (lineStart) {
			inBlockquoteLine = ch === '>';
			lineStart = false;
		}

		if (escaped) {
			escaped = false;
			i++;
			if (ch === '\n') {
				lineStart = true;
				inBlockquoteLine = false;
			}
			if (stack.length === 0) longestValidEnd = i;
			continue;
		}

		if (ch === '\\') {
			escaped = true;
			i++;
			continue;
		}

		if (top?.type === 'link-url') {
			if (ch === ')') {
				stack.pop();
				i++;
				if (stack.length === 0) longestValidEnd = i;
				continue;
			}
			if (ch === '\n') {
				lineStart = true;
				inBlockquoteLine = false;
			}
			i++;
			continue;
		}

		if (top?.type === 'code') {
			if (top.token === '```') {
				if (md.startsWith('```', i)) {
					stack.pop();
					i += 3;
					if (stack.length === 0) longestValidEnd = i;
					continue;
				}
			} else if (ch === '`') {
				stack.pop();
				i++;
				if (stack.length === 0) longestValidEnd = i;
				continue;
			}
			if (ch === '\n') {
				lineStart = true;
				inBlockquoteLine = false;
			}
			i++;
			continue;
		}

		if (ch === ']' && top?.type === 'link-text') {
			stack.pop();
			i++;
			if (md[i] === '(') {
				stack.push({ type: 'link-url' });
				i++;
			}
			if (stack.length === 0) longestValidEnd = i;
			continue;
		}

		if (ch === '!' && md[i + 1] === '[') {
			stack.push({ type: 'link-text' });
			i += 2;
			continue;
		}
		if (ch === '[') {
			stack.push({ type: 'link-text' });
			i++;
			continue;
		}

		if (md.startsWith('```', i)) {
			const currentTop = stack[stack.length - 1];
			if (currentTop?.type === 'code' && currentTop.token === '```') {
				stack.pop();
			} else {
				stack.push({ type: 'code', token: '```' });
			}
			i += 3;
			if (stack.length === 0) longestValidEnd = i;
			continue;
		}

		if (ch === '`') {
			const currentTop = stack[stack.length - 1];
			if (currentTop?.type === 'code' && currentTop.token === '`') {
				stack.pop();
			} else {
				stack.push({ type: 'code', token: '`' });
			}
			i++;
			if (stack.length === 0) longestValidEnd = i;
			continue;
		}

		if (ch === '|' && md[i + 1] === '|') {
			if (!isExpandableBlockquoteMarker(md, i, inBlockquoteLine)) {
				toggleStyle(stack, '||');
			}
			i += 2;
			if (stack.length === 0) longestValidEnd = i;
			continue;
		}

		// Telegram 规则中 __ 对 _ 采用贪婪优先匹配。
		if (ch === '_' && md[i + 1] === '_') {
			toggleStyle(stack, '__');
			i += 2;
			if (stack.length === 0) longestValidEnd = i;
			continue;
		}
		if (ch === '_') {
			toggleStyle(stack, '_');
			i++;
			if (stack.length === 0) longestValidEnd = i;
			continue;
		}
		if (ch === '*') {
			toggleStyle(stack, '*');
			i++;
			if (stack.length === 0) longestValidEnd = i;
			continue;
		}
		if (ch === '~') {
			toggleStyle(stack, '~');
			i++;
			if (stack.length === 0) longestValidEnd = i;
			continue;
		}

		i++;
		if (ch === '\n') {
			lineStart = true;
			inBlockquoteLine = false;
		}
		if (stack.length === 0) longestValidEnd = i;
	}

	return longestValidEnd;
}
