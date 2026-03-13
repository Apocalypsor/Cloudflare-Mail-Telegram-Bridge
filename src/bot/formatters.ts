import { InlineKeyboard } from 'grammy';
import type { Account, TelegramUser } from '../types';
import { AccountType } from '../types';

export function accountDetailText(account: Account, ownerName?: string): string {
	let text = `📧 账号详情 #${account.id}\n\n`;
	if (account.type === AccountType.Imap) {
		text += `类型: 📬 IMAP\n`;
		text += `邮箱: ${account.email || '(未设置)'}\n`;
		text += `Chat ID: ${account.chat_id}\n`;
		text += `服务器: ${account.imap_host}:${account.imap_port}${account.imap_secure ? ' (TLS)' : ''}\n`;
		text += `用户名: ${account.imap_user}`;
	} else {
		const status = account.refresh_token ? '✅ 已授权' : '❌ 未授权';
		const typeName = account.type === AccountType.Outlook ? '📮 Outlook' : '📨 Gmail';
		text += `类型: ${typeName}\n`;
		text += `邮箱: ${account.email || '(未设置)'}\n`;
		text += `Chat ID: ${account.chat_id}\n`;
		text += `状态: ${status}`;
	}
	if (ownerName !== undefined) {
		text += `\n所有者: ${ownerName || '(无)'}`;
	}
	return text;
}

export function accountDetailKeyboard(account: Account): InlineKeyboard {
	const kb = new InlineKeyboard();
	if (account.type === AccountType.Imap) {
		kb.text('✏️ 编辑', `acc:${account.id}:edit`).row();
		kb.text('❌ 删除', `acc:${account.id}:del`).row();
		kb.text('« 返回账号列表', 'accs');
	} else {
		const authLabel = account.refresh_token ? '🔑 重新授权' : '🔑 授权';
		kb.text(authLabel, `acc:${account.id}:auth`);
		if (account.refresh_token) {
			kb.text('🔄 Watch', `acc:${account.id}:w`);
		}
		kb.row();
		kb.text('✏️ 编辑', `acc:${account.id}:edit`);
		kb.row();
		kb.text('❌ 删除', `acc:${account.id}:del`);
		kb.row();
		kb.text('« 返回账号列表', 'accs');
	}
	return kb;
}

export function formatUserName(user: { first_name: string; last_name?: string | null }): string {
	return user.first_name + (user.last_name ? ` ${user.last_name}` : '');
}

export function userListText(users: TelegramUser[]): string {
	if (users.length === 0) return '👥 暂无用户';

	let text = `👥 用户列表 (${users.length})\n\n`;
	for (const u of users) {
		const status = u.approved === 1 ? '✅' : '⏳';
		const name = formatUserName(u);
		const username = u.username ? ` @${u.username}` : '';
		text += `${status} ${name}${username}\n   ID: ${u.telegram_id}\n`;
	}
	return text;
}
