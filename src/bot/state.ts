import type { Env } from '../types';

const BOT_STATE_TTL = 300; // 5 minutes

function botStateKey(userId: string): string {
	return `bot_state:${userId}`;
}

export type BotInputState =
	| { action: 'add'; step: 'chat_id' }
	| { action: 'add'; step: 'label'; chatId: string }
	| { action: 'add'; step: 'type'; chatId: string; label?: string }
	| { action: 'add_imap'; step: 'host'; chatId: string; label?: string }
	| { action: 'add_imap'; step: 'port'; chatId: string; label?: string; imapHost: string }
	| { action: 'add_imap'; step: 'secure'; chatId: string; label?: string; imapHost: string; imapPort: number }
	| { action: 'add_imap'; step: 'user'; chatId: string; label?: string; imapHost: string; imapPort: number; imapSecure: boolean }
	| { action: 'add_imap'; step: 'pass'; chatId: string; label?: string; imapHost: string; imapPort: number; imapSecure: boolean; imapUser: string }
	| { action: 'edit_chatid'; accountId: number }
	| { action: 'edit_label'; accountId: number };

export async function getBotState(env: Env, userId: string): Promise<BotInputState | null> {
	const raw = await env.EMAIL_KV.get(botStateKey(userId));
	return raw ? JSON.parse(raw) : null;
}

export async function setBotState(env: Env, userId: string, state: BotInputState): Promise<void> {
	await env.EMAIL_KV.put(botStateKey(userId), JSON.stringify(state), { expirationTtl: BOT_STATE_TTL });
}

export async function clearBotState(env: Env, userId: string): Promise<void> {
	await env.EMAIL_KV.delete(botStateKey(userId));
}
