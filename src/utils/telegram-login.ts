/**
 * Telegram Login Widget 数据验证
 * https://core.telegram.org/widgets/login#checking-authorization
 */

export interface TelegramLoginData {
	id: number;
	first_name: string;
	last_name?: string;
	username?: string;
	photo_url?: string;
	auth_date: number;
	hash: string;
}

/** 验证 Telegram Login Widget 回调数据 */
export async function verifyTelegramLogin(botToken: string, data: TelegramLoginData): Promise<boolean> {
	// auth_date 不能超过 5 分钟
	const now = Math.floor(Date.now() / 1000);
	if (now - data.auth_date > 300) return false;

	// data_check_string: 按字母排序的 key=value，不含 hash
	const checkString = Object.entries(data)
		.filter(([k, v]) => k !== 'hash' && v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${v}`)
		.join('\n');

	// secret_key = SHA256(bot_token)
	const tokenBytes = new TextEncoder().encode(botToken);
	const secretKey = await crypto.subtle.digest('SHA-256', tokenBytes);

	// hash = HMAC-SHA256(secret_key, data_check_string)
	const key = await crypto.subtle.importKey('raw', secretKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(checkString));
	const computed = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	return computed === data.hash;
}

/** 从 URL query params 解析 Telegram Login 数据 */
export function parseTelegramLoginParams(params: URLSearchParams): TelegramLoginData | null {
	const id = params.get('id');
	const firstName = params.get('first_name');
	const authDate = params.get('auth_date');
	const hash = params.get('hash');

	if (!id || !firstName || !authDate || !hash) return null;

	return {
		id: parseInt(id, 10),
		first_name: firstName,
		last_name: params.get('last_name') || undefined,
		username: params.get('username') || undefined,
		photo_url: params.get('photo_url') || undefined,
		auth_date: parseInt(authDate, 10),
		hash,
	};
}
