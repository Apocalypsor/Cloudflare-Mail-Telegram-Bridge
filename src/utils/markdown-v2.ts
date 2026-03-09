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

/**
 * 线性扫描 Telegram MarkdownV2 文本，返回“最长合法前缀”终点下标。
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
