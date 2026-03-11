import { Api } from 'grammy';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { accountDetailKeyboard, accountDetailText } from '../../../../bot/formatters';
import { OAuthCallbackPage, OAuthErrorPage, OAuthSetupPage } from '../../../../components/oauth';
import { getAccountById } from '../../../../db/accounts';
import { getOAuthPageProps, processOAuthCallback, startGoogleOAuth } from '../../../../services/email/gmail/oauth';
import type { AppEnv } from '../../../../types';
import { ROUTE_OAUTH_GOOGLE, ROUTE_OAUTH_GOOGLE_CALLBACK, ROUTE_OAUTH_GOOGLE_START } from '../../routes';

const gmailOauth = new Hono<AppEnv>();

gmailOauth.get(ROUTE_OAUTH_GOOGLE, async (c) => {
	const accountId = parseInt(c.req.query('account') || '0', 10);
	if (isNaN(accountId) || accountId <= 0) return c.text('Invalid account ID', 400);
	const account = await getAccountById(c.env.DB, accountId);
	if (!account) return c.text('Account not found', 404);

	const props = getOAuthPageProps(c.req.raw, account.id, account.email || `Account #${account.id}`);
	return c.html(<OAuthSetupPage {...props} />);
});

gmailOauth.get(ROUTE_OAUTH_GOOGLE_START, async (c) => {
	const accountId = parseInt(c.req.query('account') || '0', 10);
	if (isNaN(accountId) || accountId <= 0) return c.text('Invalid account ID', 400);
	const account = await getAccountById(c.env.DB, accountId);
	if (!account) return c.text('Account not found', 404);

	return startGoogleOAuth(c.req.raw, c.env, account.id);
});

gmailOauth.get(ROUTE_OAUTH_GOOGLE_CALLBACK, async (c) => {
	const result = await processOAuthCallback(c.req.raw, c.env);
	if (!result.ok) {
		return c.html(
			<OAuthErrorPage title={result.title} detail={result.detail} />,
			result.status as ContentfulStatusCode,
		);
	}

	// 尝试更新 bot 中的授权消息
	const botMsgKey = `oauth_bot_msg:${result.accountId}`;
	const botMsgRaw = await c.env.EMAIL_KV.get(botMsgKey);
	if (botMsgRaw) {
		try {
			const { chatId, messageId } = JSON.parse(botMsgRaw) as { chatId: string; messageId: number };
			const account = await getAccountById(c.env.DB, result.accountId);
			if (account) {
				const api = new Api(c.env.TELEGRAM_BOT_TOKEN);
				await api.editMessageText(chatId, messageId, accountDetailText(account), {
					reply_markup: accountDetailKeyboard(account),
				});
			}
		} catch {
			/* best-effort: don't break OAuth success page */
		}
		await c.env.EMAIL_KV.delete(botMsgKey);
	}

	return c.html(
		<OAuthCallbackPage
			refreshToken={result.refreshToken}
			scope={result.scope}
			expiresIn={result.expiresIn}
			accountEmail={result.accountEmail}
		/>,
	);
});

export default gmailOauth;
