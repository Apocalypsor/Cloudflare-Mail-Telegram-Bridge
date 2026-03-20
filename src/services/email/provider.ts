import { IMAP_FLAG_FLAGGED, IMAP_FLAG_SEEN } from '@/constants';
import type { Account, Env } from '@/types';
import { AccountType } from '@/types';
import {
	addStar,
	getAccessToken,
	isJunk as gmailIsJunk,
	isStarred as gmailIsStarred,
	listJunkMessages,
	listStarredMessages,
	listUnreadMessages,
	markAsRead,
	removeStar,
	markAsJunk as gmailMarkAsJunk,
	moveToInbox as gmailMoveToInbox,
	trashMessage as gmailTrashMessage,
	trashAllJunk as gmailDeleteAllJunk,
} from '@services/email/gmail/index';
import { imapTrashAllJunk, imapTrashMessage, imapMarkAsJunk, imapMoveToInbox, isImapJunk, isImapStarred, listImapJunk, listImapStarred, listImapUnread, setImapFlag } from '@services/email/imap';
import {
	addStar as msAddStar,
	getAccessToken as msGetAccessToken,
	isJunk as msIsJunk,
	isStarred as msIsStarred,
	listJunkMessages as msListJunkMessages,
	listStarredMessages as msListStarredMessages,
	listUnreadMessages as msListUnreadMessages,
	markAsRead as msMarkAsRead,
	removeStar as msRemoveStar,
	markAsJunk as msMarkAsJunk,
	moveToInbox as msMoveToInbox,
	trashMessage as msTrashMessage,
	trashAllJunk as msDeleteAllJunk,
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
	isJunk(messageId: string): Promise<boolean>;
	listUnread(maxResults?: number): Promise<EmailListItem[]>;
	listStarred(maxResults?: number): Promise<EmailListItem[]>;
	listJunk(maxResults?: number): Promise<EmailListItem[]>;
	markAsJunk(messageId: string): Promise<void>;
	moveToInbox(messageId: string): Promise<void>;
	trashMessage(messageId: string): Promise<void>;
	trashAllJunk(): Promise<number>;
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
			isJunk: (messageId) => isImapJunk(env, account.id, messageId),
			listUnread: (maxResults) => listImapUnread(env, account.id, maxResults),
			listStarred: (maxResults) => listImapStarred(env, account.id, maxResults),
			listJunk: (maxResults) => listImapJunk(env, account.id, maxResults),
			markAsJunk: (messageId) => imapMarkAsJunk(env, account.id, messageId),
			moveToInbox: (messageId) => imapMoveToInbox(env, account.id, messageId),
			trashMessage: (messageId) => imapTrashMessage(env, account.id, messageId),
			trashAllJunk: () => imapTrashAllJunk(env, account.id),
		};
	}

	if (account.type === AccountType.Outlook) {
		const t = () => msGetAccessToken(env, account);
		return {
			markAsRead: withToken(t, msMarkAsRead),
			addStar: withToken(t, msAddStar),
			removeStar: withToken(t, msRemoveStar),
			isStarred: withToken(t, msIsStarred),
			isJunk: withToken(t, msIsJunk),
			listUnread: withToken(t, msListUnreadMessages),
			listStarred: withToken(t, msListStarredMessages),
			listJunk: withToken(t, msListJunkMessages),
			markAsJunk: withToken(t, msMarkAsJunk),
			moveToInbox: withToken(t, msMoveToInbox),
			trashMessage: withToken(t, msTrashMessage),
			trashAllJunk: withToken(t, msDeleteAllJunk),
		};
	}

	// Gmail provider
	const t = () => getAccessToken(env, account);
	return {
		markAsRead: withToken(t, markAsRead),
		addStar: withToken(t, addStar),
		removeStar: withToken(t, removeStar),
		isStarred: withToken(t, gmailIsStarred),
		isJunk: withToken(t, gmailIsJunk),
		listUnread: withToken(t, listUnreadMessages),
		listStarred: withToken(t, listStarredMessages),
		listJunk: withToken(t, listJunkMessages),
		markAsJunk: withToken(t, gmailMarkAsJunk),
		moveToInbox: withToken(t, gmailMoveToInbox),
		trashMessage: withToken(t, gmailTrashMessage),
		trashAllJunk: withToken(t, gmailDeleteAllJunk),
	};
}
