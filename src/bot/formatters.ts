import { InlineKeyboard } from 'grammy';
import type { Account } from '../types';

export function accountDetailText(account: Account): string {
	const status = account.refresh_token ? '✅ 已授权' : '❌ 未授权';
	let text = `📧 账号详情 #${account.id}\n\n`;
	text += `邮箱: ${account.email || '(未设置)'}\n`;
	text += `Chat ID: ${account.chat_id}\n`;
	text += `标签: ${account.label || '(无)'}\n`;
	text += `状态: ${status}`;
	return text;
}

export function accountDetailKeyboard(account: Account): InlineKeyboard {
	const kb = new InlineKeyboard();
	const authLabel = account.refresh_token ? '🔑 重新授权' : '🔑 授权';
	kb.text(authLabel, `acc:${account.id}:auth`);
	if (account.refresh_token) {
		kb.text('🔄 Watch', `acc:${account.id}:w`);
	}
	kb.row();
	kb.text('✏️ 编辑', `acc:${account.id}:edit`);
	kb.text('🗑 清除缓存', `acc:${account.id}:cc`);
	kb.row();
	kb.text('❌ 删除', `acc:${account.id}:del`);
	kb.row();
	kb.text('« 返回账号列表', 'accs');
	return kb;
}

export function formatUserName(user: { first_name: string; last_name?: string | null }): string {
	return user.first_name + (user.last_name ? ` ${user.last_name}` : '');
}
