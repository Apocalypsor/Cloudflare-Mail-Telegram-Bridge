import { IMAP_FLAG_FLAGGED, IMAP_FLAG_SEEN } from '@/constants';
import type { Account, Env } from '@/types';
import { AccountType } from '@/types';
import {
	addStar,
	getAccessToken,
	isStarred as gmailIsStarred,
	listStarredMessages,
	listUnreadMessages,
	markAsRead,
	removeStar,
} from '@services/email/gmail/index';
import { isImapStarred, listImapStarred, listImapUnread, setImapFlag } from '@services/email/imap';
import {
	addStar as msAddStar,
	getAccessToken as msGetAccessToken,
	isStarred as msIsStarred,
	listStarredMessages as msListStarredMessages,
	listUnreadMessages as msListUnreadMessages,
	markAsRead as msMarkAsRead,
	removeStar as msRemoveStar,
} from '@services/email/outlook/index';

export interface EmailListItem {
	id: string;
	subject?: string;
}

export interface EmailProvider {
	markAsRead(messageId: string): Promise<void>;
	addStar(messageId: string): Promise<void>;
	removeStar(messageId: string): Promise<void>;
	isStarred(messageId: string): Promise<boolean>;
	listUnread(maxResults?: number): Promise<EmailListItem[]>;
	listStarred(maxResults?: number): Promise<EmailListItem[]>;
}

export function getEmailProvider(account: Account, env: Env): EmailProvider {
	if (account.type === AccountType.Imap) {
		return {
			markAsRead: (messageId) => setImapFlag(env, account.id, messageId, IMAP_FLAG_SEEN, true),
			addStar: (messageId) => setImapFlag(env, account.id, messageId, IMAP_FLAG_FLAGGED, true),
			removeStar: (messageId) => setImapFlag(env, account.id, messageId, IMAP_FLAG_FLAGGED, false),
			isStarred: (messageId) => isImapStarred(env, account.id, messageId),
			listUnread: (maxResults) => listImapUnread(env, account.id, maxResults),
			listStarred: (maxResults) => listImapStarred(env, account.id, maxResults),
		};
	}

	if (account.type === AccountType.Outlook) {
		return {
			markAsRead: async (messageId) => {
				const token = await msGetAccessToken(env, account);
				await msMarkAsRead(token, messageId);
			},
			addStar: async (messageId) => {
				const token = await msGetAccessToken(env, account);
				await msAddStar(token, messageId);
			},
			removeStar: async (messageId) => {
				const token = await msGetAccessToken(env, account);
				await msRemoveStar(token, messageId);
			},
			isStarred: async (messageId) => {
				const token = await msGetAccessToken(env, account);
				return msIsStarred(token, messageId);
			},
			listUnread: async (maxResults) => {
				const token = await msGetAccessToken(env, account);
				return msListUnreadMessages(token, maxResults);
			},
			listStarred: async (maxResults) => {
				const token = await msGetAccessToken(env, account);
				return msListStarredMessages(token, maxResults);
			},
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
		isStarred: async (messageId) => {
			const token = await getAccessToken(env, account);
			return gmailIsStarred(token, messageId);
		},
		listUnread: async (maxResults) => {
			const token = await getAccessToken(env, account);
			return listUnreadMessages(token, maxResults);
		},
		listStarred: async (maxResults) => {
			const token = await getAccessToken(env, account);
			return listStarredMessages(token, maxResults);
		},
	};
}
