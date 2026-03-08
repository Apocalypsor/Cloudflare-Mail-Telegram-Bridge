import { formatBody } from '../lib/format';

export function convertPreview(html: string): { result: string; length: number } {
	const result = formatBody(undefined, html, 4000);
	return { result, length: result.length };
}
