import { IMAP_FLAG_FLAGGED, IMAP_FLAG_SEEN } from '@/constants';
import type { Account, Env } from '@/types';
import { AccountType } from '@/types';
import {
	addStar,
	getAccessToken,
	isStarred as gmailIsStarred,
	listJunkMessages,
	listStarredMessages,
	listUnreadMessages,
	markAsRead,
	removeStar,
	markAsJunk as gmailMarkAsJunk,
	moveToInbox as gmailMoveToInbox,
	trashMessage as gmailTrashMessage,
	deleteAllJunk as gmailDeleteAllJunk,
} from '@services/email/gmail/index';
import { imapDeleteAllJunk, imapDeleteMessage, imapMarkAsJunk, imapMoveToInbox, isImapStarred, listImapJunk, listImapStarred, listImapUnread, setImapFlag } from '@services/email/imap';
import {
	addStar as msAddStar,
	getAccessToken as msGetAccessToken,
	isStarred as msIsStarred,
	listJunkMessages as msListJunkMessages,
	listStarredMessages as msListStarredMessages,
	listUnreadMessages as msListUnreadMessages,
	markAsRead as msMarkAsRead,
	removeStar as msRemoveStar,
	markAsJunk as msMarkAsJunk,
	moveToInbox as msMoveToInbox,
	deleteMessage as msDeleteMessage,
	deleteAllJunk as msDeleteAllJunk,
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
	listJunk(maxResults?: number): Promise<EmailListItem[]>;
	markAsJunk(messageId: string): Promise<void>;
	moveToInbox(messageId: string): Promise<void>;
	deleteMessage(messageId: string): Promise<void>;
	deleteAllJunk(): Promise<number>;
}

/** 将 (token, ...args) => R 的函数包装为 (...args) => R，自动注入 token */
function withToken<A extends unknown[], R>(
	getToken: () => Promise<string>,
	fn: (token: string, ...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	return async (...args) => fn(await getToken(), ...args);
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
			listJunk: (maxResults) => listImapJunk(env, account.id, maxResults),
			markAsJunk: (messageId) => imapMarkAsJunk(env, account.id, messageId),
			moveToInbox: (messageId) => imapMoveToInbox(env, account.id, messageId),
			deleteMessage: (messageId) => imapDeleteMessage(env, account.id, messageId),
			deleteAllJunk: () => imapDeleteAllJunk(env, account.id),
		};
	}

	if (account.type === AccountType.Outlook) {
		const t = () => msGetAccessToken(env, account);
		return {
			markAsRead: withToken(t, msMarkAsRead),
			addStar: withToken(t, msAddStar),
			removeStar: withToken(t, msRemoveStar),
			isStarred: withToken(t, msIsStarred),
			listUnread: withToken(t, msListUnreadMessages),
			listStarred: withToken(t, msListStarredMessages),
			listJunk: withToken(t, msListJunkMessages),
			markAsJunk: withToken(t, msMarkAsJunk),
			moveToInbox: withToken(t, msMoveToInbox),
			deleteMessage: withToken(t, msDeleteMessage),
			deleteAllJunk: withToken(t, msDeleteAllJunk),
		};
	}

	// Gmail provider
	const t = () => getAccessToken(env, account);
	return {
		markAsRead: withToken(t, markAsRead),
		addStar: withToken(t, addStar),
		removeStar: withToken(t, removeStar),
		isStarred: withToken(t, gmailIsStarred),
		listUnread: withToken(t, listUnreadMessages),
		listStarred: withToken(t, listStarredMessages),
		listJunk: withToken(t, listJunkMessages),
		markAsJunk: withToken(t, gmailMarkAsJunk),
		moveToInbox: withToken(t, gmailMoveToInbox),
		deleteMessage: withToken(t, gmailTrashMessage),
		deleteAllJunk: withToken(t, gmailDeleteAllJunk),
	};
}
