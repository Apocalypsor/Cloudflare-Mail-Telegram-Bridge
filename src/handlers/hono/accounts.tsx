import { Hono } from 'hono';
import { DashboardPage } from '../../components/home';
import { createAccount, deleteAccount, getAccountById, getAllAccounts, updateAccount } from '../../db/accounts';
import { clearAccountCache, clearAllKV, deleteHistoryId } from '../../db/kv';
import { renewWatch, stopWatch } from '../../services/gmail';
import type { Env } from '../../types';
import { requireSession } from './middleware';
import {
	ROUTE_ACCOUNTS,
	ROUTE_ACCOUNTS_CLEAR_CACHE,
	ROUTE_ACCOUNTS_DELETE,
	ROUTE_ACCOUNTS_EDIT,
	ROUTE_ACCOUNTS_WATCH,
	ROUTE_CLEAR_ALL_KV,
} from './routes';

const accounts = new Hono<{ Bindings: Env }>();

accounts.post(ROUTE_ACCOUNTS, requireSession(), async (c) => {
	const form = await c.req.formData();
	const chatId = form.get('chat_id');
	const label = form.get('label');

	if (typeof chatId !== 'string' || !chatId.trim()) {
		const allAccounts = await getAllAccounts(c.env.DB);
		return c.html(<DashboardPage accounts={allAccounts} error="Chat ID 不能为空" />);
	}

	try {
		await createAccount(c.env.DB, chatId.trim(), typeof label === 'string' && label.trim() ? label.trim() : undefined);
	} catch (err: any) {
		const allAccounts = await getAllAccounts(c.env.DB);
		return c.html(<DashboardPage accounts={allAccounts} error={err.message} />);
	}

	return c.redirect('/');
});

accounts.post(ROUTE_ACCOUNTS_EDIT, requireSession(), async (c) => {
	const id = parseInt(c.req.param('id'), 10);
	const form = await c.req.formData();
	const chatId = form.get('chat_id');
	const label = form.get('label');

	if (typeof chatId !== 'string' || !chatId.trim()) {
		return c.text('Chat ID 不能为空', 400);
	}

	const account = await getAccountById(c.env.DB, id);
	if (!account) return c.text('Account not found', 404);

	await updateAccount(c.env.DB, id, chatId.trim(), typeof label === 'string' && label.trim() ? label.trim() : null);
	return c.redirect('/');
});

accounts.post(ROUTE_ACCOUNTS_DELETE, requireSession(), async (c) => {
	const id = parseInt(c.req.param('id'), 10);
	const account = await getAccountById(c.env.DB, id);
	if (account?.refresh_token) {
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
	await clearAccountCache(c.env, id);
	return c.text(`Cache cleared for account ${id}`);
});

accounts.post(ROUTE_CLEAR_ALL_KV, requireSession(), async (c) => {
	const deleted = await clearAllKV(c.env);
	return c.text(`Deleted ${deleted} KV keys`);
});

accounts.post(ROUTE_ACCOUNTS_WATCH, requireSession(), async (c) => {
	const id = parseInt(c.req.param('id'), 10);
	const account = await getAccountById(c.env.DB, id);
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
