/** 生成邮件查看链接的 HMAC-SHA256 token */
export async function generateMailToken(secret: string, gmailMessageId: string, chatId: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
	]);
	const data = new TextEncoder().encode(`${gmailMessageId}:${chatId}`);
	const sig = await crypto.subtle.sign('HMAC', key, data);
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

/** 验证邮件查看链接的 token */
export async function verifyMailToken(
	secret: string,
	gmailMessageId: string,
	chatId: string,
	token: string,
): Promise<boolean> {
	const expected = await generateMailToken(secret, gmailMessageId, chatId);
	return expected === token;
}
