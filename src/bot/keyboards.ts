import type { Env } from '@/types';
import { getAccountById } from '@db/accounts';
import { getMessageMapping } from '@db/message-map';
import { getEmailProvider } from '@services/email/provider';
import { generateMailToken } from '@utils/hash';
import { InlineKeyboard } from 'grammy';

// ── 邮件消息键盘（星标 / 查看原文）─────────────────────────────────────────

/** 星标 inline keyboard（无查看原文按钮） */
export const STAR_KEYBOARD = new InlineKeyboard().text('⭐ 星标', 'star');
export const STARRED_KEYBOARD = new InlineKeyboard().text('✅ 已星标', 'unstar');

/** 创建带"查看原文"链接的星标键盘 */
export function starKeyboardWithMailUrl(mailUrl: string): InlineKeyboard {
	return new InlineKeyboard().text('⭐ 星标', 'star').url('📧 查看原文', mailUrl);
}

export function starredKeyboardWithMailUrl(mailUrl: string): InlineKeyboard {
	return new InlineKeyboard().text('✅ 已星标', 'unstar').url('📧 查看原文', mailUrl);
}

/** 根据星标状态构建邮件消息键盘 */
export async function buildEmailKeyboard(
	env: Env,
	emailMessageId: string,
	accountEmail: string | null,
	chatId: string,
	starred: boolean,
): Promise<InlineKeyboard> {
	if (env.WORKER_URL && accountEmail) {
		const mailToken = await generateMailToken(env.ADMIN_SECRET, emailMessageId, accountEmail, chatId);
		const mailUrl = `${env.WORKER_URL.replace(/\/$/, '')}/mail/${emailMessageId}?email=${encodeURIComponent(accountEmail)}&chatId=${encodeURIComponent(chatId)}&t=${mailToken}`;
		return starred ? starredKeyboardWithMailUrl(mailUrl) : starKeyboardWithMailUrl(mailUrl);
	}
	return starred ? STARRED_KEYBOARD : STAR_KEYBOARD;
}

/** 从邮件源查询当前星标状态后构建键盘（LLM 处理后编辑消息使用） */
export async function resolveStarredKeyboard(
	env: Env,
	chatId: string,
	tgMessageId: number,
	emailMessageId: string,
	accountEmail: string | null,
): Promise<InlineKeyboard> {
	const mapping = await getMessageMapping(env.DB, chatId, tgMessageId);
	if (!mapping) return buildEmailKeyboard(env, emailMessageId, accountEmail, chatId, false);
	const account = await getAccountById(env.DB, mapping.account_id);
	if (!account) return buildEmailKeyboard(env, emailMessageId, accountEmail, chatId, false);
	const provider = getEmailProvider(account, env);
	const starred = await provider.isStarred(emailMessageId);
	return buildEmailKeyboard(env, emailMessageId, accountEmail, chatId, starred);
}

// ── 主菜单键盘 ──────────────────────────────────────────────────────────────

/** 主菜单键盘 */
export function mainMenuKeyboard(admin: boolean): InlineKeyboard {
	const kb = new InlineKeyboard().text('📧 账号管理', 'accs').row().text('📬 未读邮件', 'unread').text('⭐ 星标邮件', 'starred').row();
	if (admin) {
		kb.text('👥 用户管理', 'users').text('⚙️ 全局操作', 'admin').row();
	}
	return kb;
}
