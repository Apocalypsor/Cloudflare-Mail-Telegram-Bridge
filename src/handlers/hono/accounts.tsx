import { Hono } from 'hono';
import { DashboardPage } from '../../components/home';
import { createAccount, deleteAccount, getAuthorizedAccount, getVisibleAccounts, updateAccount } from '../../db/accounts';
import { clearAccountCache, clearAllKV, deleteHistoryId } from '../../db/kv';
import { getAllUsers } from '../../db/users';
import { renewWatch, stopWatch } from '../../services/gmail';
import type { AppEnv } from '../../types';
import { requireAdmin, requireSession } from './middleware';
import {
	ROUTE_ACCOUNTS,
	ROUTE_ACCOUNTS_CLEAR_CACHE,
	ROUTE_ACCOUNTS_DELETE,
	ROUTE_ACCOUNTS_EDIT,
	ROUTE_ACCOUNTS_WATCH,
	ROUTE_CLEAR_ALL_KV,
} from './routes';

const accounts = new Hono<AppEnv>();

accounts.post(ROUTE_ACCOUNTS, requireSession(), async (c) => {
	const form = await c.req.formData();
	const chatId = form.get('chat_id');
	const label = form.get('label');
	const isAdmin = c.get('isAdmin');
	const userId = c.get('userId');

	if (typeof chatId !== 'string' || !chatId.trim() || !/^-?\d+$/.test(chatId.trim())) {
		const [visible, allUsers] = await Promise.all([getVisibleAccounts(c.env.DB, userId, isAdmin), isAdmin ? getAllUsers(c.env.DB) : []]);
		return c.html(<DashboardPage accounts={visible} isAdmin={isAdmin} users={allUsers} userId={userId} error="Chat ID 必须为数字" />);
	}

	// Admin 可指定 owner，普通用户自动绑定自己
	let ownerTelegramId = userId;
	if (isAdmin) {
		const formOwner = form.get('telegram_user_id');
		if (typeof formOwner === 'string' && formOwner.trim()) {
			ownerTelegramId = formOwner.trim();
		}
	}

	try {
		await createAccount(c.env.DB, chatId.trim(), typeof label === 'string' && label.trim() ? label.trim() : undefined, ownerTelegramId);
	} catch (err: any) {
		const [visible, allUsers] = await Promise.all([getVisibleAccounts(c.env.DB, userId, isAdmin), isAdmin ? getAllUsers(c.env.DB) : []]);
		return c.html(<DashboardPage accounts={visible} isAdmin={isAdmin} users={allUsers} userId={userId} error={err.message} />);
	}

	return c.redirect('/');
});

accounts.post(ROUTE_ACCOUNTS_EDIT, requireSession(), async (c) => {
	const id = parseInt(c.req.param('id'), 10);
	if (isNaN(id) || id <= 0) return c.text('Invalid account ID', 400);
	const form = await c.req.formData();
	const chatId = form.get('chat_id');
	const label = form.get('label');

	if (typeof chatId !== 'string' || !chatId.trim() || !/^-?\d+$/.test(chatId.trim())) {
		return c.text('Chat ID 必须为数字', 400);
	}

	const account = await getAuthorizedAccount(c.env.DB, id, c.get('userId'), c.get('isAdmin'));
	if (!account) return c.text('Account not found', 404);

	// Admin 可修改 owner
	let telegramUserId: string | null | undefined = undefined;
	if (c.get('isAdmin')) {
		const formOwner = form.get('telegram_user_id');
		telegramUserId = typeof formOwner === 'string' && formOwner.trim() ? formOwner.trim() : null;
	}

	await updateAccount(c.env.DB, id, chatId.trim(), typeof label === 'string' && label.trim() ? label.trim() : null, telegramUserId);
	return c.redirect('/');
});

accounts.post(ROUTE_ACCOUNTS_DELETE, requireSession(), async (c) => {
	const id = parseInt(c.req.param('id'), 10);
	if (isNaN(id) || id <= 0) return c.text('Invalid account ID', 400);
	const account = await getAuthorizedAccount(c.env.DB, id, c.get('userId'), c.get('isAdmin'));
	if (!account) return c.text('Account not found', 404);

	if (account.refresh_token) {
		try {
			await stopWatch(c.env, account);
		} catch (err) {
			console.warn(`Failed to stop watch for ${account.email}:`, err);
		}
	}
	await Promise.all([deleteAccount(c.env.DB, id), deleteHistoryId(c.env, id)]);
	return c.text('OK');
});

accounts.post(ROUTE_ACCOUNTS_CLEAR_CACHE, requireSession(), async (c) => {
	const id = parseInt(c.req.param('id'), 10);
	if (isNaN(id) || id <= 0) return c.text('Invalid account ID', 400);
	const account = await getAuthorizedAccount(c.env.DB, id, c.get('userId'), c.get('isAdmin'));
	if (!account) return c.text('Account not found', 404);

	await clearAccountCache(c.env, id);
	return c.text(`Cache cleared for account ${id}`);
});

accounts.post(ROUTE_CLEAR_ALL_KV, requireSession(), requireAdmin(), async (c) => {
	const deleted = await clearAllKV(c.env);
	return c.text(`Deleted ${deleted} KV keys`);
});

accounts.post(ROUTE_ACCOUNTS_WATCH, requireSession(), async (c) => {
	const id = parseInt(c.req.param('id'), 10);
	if (isNaN(id) || id <= 0) return c.text('Invalid account ID', 400);
	const account = await getAuthorizedAccount(c.env.DB, id, c.get('userId'), c.get('isAdmin'));
	if (!account) return c.text('Account not found', 404);
	if (!account.refresh_token) return c.text('Account not authorized', 400);

	try {
		await renewWatch(c.env, account);
		return c.text(`Watch renewed for ${account.email}`);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return c.text(`Watch failed: ${message}`, 500);
	}
});

export default accounts;
