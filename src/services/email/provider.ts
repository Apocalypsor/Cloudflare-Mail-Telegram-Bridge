import { IMAP_FLAG_FLAGGED, IMAP_FLAG_SEEN } from '../../constants';
import type { Account, Env } from '../../types';
import { AccountType } from '../../types';
import { addStar, getAccessToken, markAsRead, removeStar } from './gmail/index';
import { setImapFlag } from './imap/bridge';

export interface EmailProvider {
	markAsRead(messageId: string): Promise<void>;
	addStar(messageId: string): Promise<void>;
	removeStar(messageId: string): Promise<void>;
}

export function getEmailProvider(account: Account, env: Env): EmailProvider {
	if (account.type === AccountType.Imap) {
		return {
			markAsRead: (messageId) => setImapFlag(env, account.id, messageId, IMAP_FLAG_SEEN, true),
			addStar: (messageId) => setImapFlag(env, account.id, messageId, IMAP_FLAG_FLAGGED, true),
			removeStar: (messageId) => setImapFlag(env, account.id, messageId, IMAP_FLAG_FLAGGED, false),
		};
	}

	// Gmail provider
	return {
		markAsRead: async (messageId) => {
			const token = await getAccessToken(env, account);
			await markAsRead(token, messageId);
		},
		addStar: async (messageId) => {
			const token = await getAccessToken(env, account);
			await addStar(token, messageId);
		},
		removeStar: async (messageId) => {
			const token = await getAccessToken(env, account);
			await removeStar(token, messageId);
		},
	};
}
