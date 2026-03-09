import { InlineKeyboard } from 'grammy';

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
