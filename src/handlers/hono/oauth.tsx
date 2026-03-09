import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { OAuthCallbackPage, OAuthErrorPage, OAuthSetupPage } from '../../components/oauth';
import { getAccountById } from '../../db/accounts';
import { getOAuthPageProps, processOAuthCallback, startGoogleOAuth } from '../../services/oauth';
import type { Env } from '../../types';
import { requireSecret } from './middleware';
import { ROUTE_OAUTH_GOOGLE, ROUTE_OAUTH_GOOGLE_CALLBACK, ROUTE_OAUTH_GOOGLE_START } from './routes';

const oauth = new Hono<{ Bindings: Env }>();

oauth.get(ROUTE_OAUTH_GOOGLE, requireSecret('GMAIL_WATCH_SECRET'), async (c) => {
	const accountId = parseInt(c.req.query('account') || '0', 10);
	const account = await getAccountById(c.env.DB, accountId);
	if (!account) return c.text('Account not found', 404);

	const props = getOAuthPageProps(c.req.raw, c.env, account.id, account.email || `Account #${account.id}`);
	return c.html(<OAuthSetupPage {...props} />);
});

oauth.get(ROUTE_OAUTH_GOOGLE_START, requireSecret('GMAIL_WATCH_SECRET'), async (c) => {
	const accountId = parseInt(c.req.query('account') || '0', 10);
	const account = await getAccountById(c.env.DB, accountId);
	if (!account) return c.text('Account not found', 404);

	return startGoogleOAuth(c.req.raw, c.env, account.id);
});

oauth.get(ROUTE_OAUTH_GOOGLE_CALLBACK, async (c) => {
	const result = await processOAuthCallback(c.req.raw, c.env);
	if (!result.ok) {
		return c.html(
			<OAuthErrorPage title={result.title} detail={result.detail} secret={result.secret} />,
			result.status as ContentfulStatusCode,
		);
	}
	return c.html(
		<OAuthCallbackPage
			refreshToken={result.refreshToken}
			scope={result.scope}
			expiresIn={result.expiresIn}
			watchUrl={result.watchUrl}
			secret={result.secret}
			accountEmail={result.accountEmail}
		/>,
	);
});

export default oauth;
