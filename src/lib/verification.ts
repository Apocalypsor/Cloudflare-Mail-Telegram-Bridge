/**
 * 从邮件正文中提取验证码。
 * 支持中英文关键词 + 4-8 位数字 / 字母数字验证码。
 * 返回第一个匹配到的验证码，或 null。
 */

const KEYWORDS = [
	// 中文
	'验证码',
	'校验码',
	'确认码',
	'动态码',
	'安全码',
	// 英文
	'verification code',
	'verify code',
	'confirmation code',
	'security code',
	'one[- ]?time (?:pass)?code',
	'auth(?:entication)? code',
	'login code',
	'passcode',
	'OTP',
	'PIN',
];

// 关键词 + 分隔符（可选 is/为/是 + 可选 :/：/=）+ 验证码
const SEP = `[\\s:：=]*(?:is|为|是)?[\\s:：=]+`;
const CODE = `([A-Za-z0-9]{4,8})\\b`;
const PATTERN = new RegExp(`(?:${KEYWORDS.join('|')})${SEP}${CODE}`, 'i');

export function extractVerificationCode(text: string): string | null {
	const m = text.match(PATTERN);
	return m?.[1] ?? null;
}
