import { describe, expect, it } from 'vitest';
import { findLongestValidMdV2Prefix, markdownToMdV2 } from '../src/utils/markdown-v2';

describe('findLongestValidMdV2Prefix', () => {
	it('returns full length for balanced entities', () => {
		const md = '*bold* _italic_ ~strike~';
		expect(findLongestValidMdV2Prefix(md)).toBe(md.length);
	});

	it('returns prefix before unmatched entity', () => {
		const md = 'hello *world';
		expect(findLongestValidMdV2Prefix(md)).toBe('hello '.length);
	});

	it('treats double-star as two bold delimiters (empty bold + plain text)', () => {
		const md = 'hello **world';
		expect(findLongestValidMdV2Prefix(md)).toBe(md.length);
	});

	it('accepts balanced double-star token', () => {
		const md = 'hello **world**';
		expect(findLongestValidMdV2Prefix(md)).toBe(md.length);
	});

	it('handles escaped markers', () => {
		const md = 'hello \\*world\\*';
		expect(findLongestValidMdV2Prefix(md)).toBe(md.length);
	});

	it('ignores entities inside fenced code', () => {
		const md = '```code * _ ~``` tail';
		expect(findLongestValidMdV2Prefix(md)).toBe(md.length);
	});

	it('handles underline, spoiler and strikethrough entities', () => {
		const md = '__u__ ||spoiler|| ~s~';
		expect(findLongestValidMdV2Prefix(md)).toBe(md.length);
	});

	it('handles markdown links', () => {
		const md = 'ok [x](https://example.com)';
		expect(findLongestValidMdV2Prefix(md)).toBe(md.length);
	});

	it('returns safe prefix for unclosed link URL', () => {
		const md = 'ok [x](https://example.com';
		expect(findLongestValidMdV2Prefix(md)).toBe('ok '.length);
	});

	it('handles custom emoji links', () => {
		const md = '![ok](tg://emoji?id=5368324170671202286)';
		expect(findLongestValidMdV2Prefix(md)).toBe(md.length);
	});

	it('keeps expandable blockquote marker valid at line end', () => {
		const md = '>expandable blockquote||';
		expect(findLongestValidMdV2Prefix(md)).toBe(md.length);
	});

	it('drops trailing dangling escape', () => {
		const md = 'abc\\';
		expect(findLongestValidMdV2Prefix(md)).toBe('abc'.length);
	});
});

describe('markdownToMdV2', () => {
	it('returns empty for empty input', () => {
		expect(markdownToMdV2('')).toBe('');
	});

	it('escapes special characters in plain text', () => {
		expect(markdownToMdV2('hello.world!')).toBe('hello\\.world\\!');
	});

	it('converts **bold** to *bold*', () => {
		expect(markdownToMdV2('**bold**')).toBe('*bold*');
	});

	it('converts *italic* to _italic_', () => {
		expect(markdownToMdV2('*italic*')).toBe('_italic_');
	});

	it('converts _italic_ to _italic_', () => {
		expect(markdownToMdV2('_italic_')).toBe('_italic_');
	});

	it('converts ***bold italic*** to *_bold italic_*', () => {
		expect(markdownToMdV2('***bold italic***')).toBe('*_bold italic_*');
	});

	it('converts __bold__ to *bold*', () => {
		expect(markdownToMdV2('__bold__')).toBe('*bold*');
	});

	it('converts ~~strike~~ to ~strike~', () => {
		expect(markdownToMdV2('~~strike~~')).toBe('~strike~');
	});

	it('preserves inline code without over-escaping', () => {
		expect(markdownToMdV2('use `console.log()`')).toBe('use `console.log()`');
	});

	it('handles fenced code blocks with language', () => {
		const input = '```js\nconst x = 1;\n```';
		const expected = '```js\nconst x = 1;\n```';
		expect(markdownToMdV2(input)).toBe(expected);
	});

	it('handles fenced code blocks without language', () => {
		const input = '```\nconst x = 1;\n```';
		const expected = '```\nconst x = 1;\n```';
		expect(markdownToMdV2(input)).toBe(expected);
	});

	it('converts links with proper escaping', () => {
		expect(markdownToMdV2('[click](https://example.com)')).toBe('[click](https://example.com)');
	});

	it('escapes special chars in link text', () => {
		expect(markdownToMdV2('[hello!](https://example.com)')).toBe('[hello\\!](https://example.com)');
	});

	it('escapes \\ in link URLs', () => {
		expect(markdownToMdV2('[x](https://a.com/b\\c)')).toBe('[x](https://a.com/b\\\\c)');
	});

	it('converts headings to bold', () => {
		expect(markdownToMdV2('## Hello World')).toBe('*Hello World*');
	});

	it('converts unordered lists', () => {
		expect(markdownToMdV2('- item one\n- item two')).toBe('•   item one\n•   item two');
	});

	it('converts ordered lists with escaped dot', () => {
		expect(markdownToMdV2('1. first\n2. second')).toBe('1\\. first\n2\\. second');
	});

	it('converts blockquotes', () => {
		expect(markdownToMdV2('> quoted text')).toBe('> quoted text');
	});

	it('escapes horizontal rules', () => {
		expect(markdownToMdV2('---')).toBe('\\-\\-\\-');
	});

	it('handles nested bold with italic', () => {
		expect(markdownToMdV2('**hello _world_**')).toBe('*hello _world_*');
	});

	it('handles mixed formatting on one line', () => {
		const input = 'Hello **world** and *text*';
		const result = markdownToMdV2(input);
		expect(result).toBe('Hello *world* and _text_');
	});

	it('does not crash on malformed URIs', () => {
		const input = '[link](https://example.com/%E2%broken)';
		expect(() => markdownToMdV2(input)).not.toThrow();
	});

	it('converts images to links', () => {
		expect(markdownToMdV2('![alt](https://img.png)')).toBe('[alt](https://img.png)');
	});

	it('handles the truncation hint pattern', () => {
		const result = markdownToMdV2('*… 正文过长，已截断 …*');
		expect(result).toBe('_… 正文过长，已截断 …_');
	});

	it('handles link inside bold (nested constructs)', () => {
		expect(markdownToMdV2('**[click](https://x.com)**')).toBe('*[click](https://x.com)*');
	});
});
