import { GMAIL_API, GMAIL_MODIFY_SCOPE, GOOGLE_OAUTH_AUTHORIZE_URL, GOOGLE_OAUTH_TOKEN_URL } from '@/constants';
import { ROUTE_OAUTH_GOOGLE_CALLBACK, ROUTE_OAUTH_GOOGLE_START } from '@handlers/hono/routes';
import { renewWatch } from '@services/email/gmail/index';
import { http } from '@utils/http';
import { createOAuthHandler, type OAuthTokenResponse } from '@services/email/oauth';

export type GoogleTokenResponse = OAuthTokenResponse;

const handler = createOAuthHandler({
	name: 'Google',
	authorizeUrl: GOOGLE_OAUTH_AUTHORIZE_URL,
	tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
	scope: GMAIL_MODIFY_SCOPE,
	startRoute: ROUTE_OAUTH_GOOGLE_START,
	callbackRoute: ROUTE_OAUTH_GOOGLE_CALLBACK,
	statePrefix: '',
	extraAuthorizeParams: { access_type: 'offline', include_granted_scopes: 'true' },
	getCredentials: (env) => ({ clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET }),
	fetchEmail: async (accessToken) => {
		const profile = (await http.get(`${GMAIL_API}/users/me/profile`, { headers: { Authorization: `Bearer ${accessToken}` } }).json()) as {
			emailAddress?: string;
		};
		return profile.emailAddress;
	},
	onAuthorized: async (env, account) => {
		await renewWatch(env, account);
		console.log(`Auto-watch activated for ${account.email}`);
	},
});

export const { getOAuthPageProps, generateOAuthUrl, processOAuthCallback } = handler;
export const startGoogleOAuth = handler.startOAuth;
