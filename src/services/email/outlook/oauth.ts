import {
  ROUTE_OAUTH_MICROSOFT_CALLBACK,
  ROUTE_OAUTH_MICROSOFT_START,
} from "@handlers/hono/routes";
import {
  createOAuthHandler,
  type OAuthTokenResponse,
} from "@services/email/oauth";
import { OutlookProvider } from "@services/email/outlook";
import { http } from "@utils/http";
import {
  MS_GRAPH_API,
  MS_MAIL_SCOPE,
  MS_OAUTH_AUTHORIZE_URL,
  MS_OAUTH_TOKEN_URL,
} from "@/constants";

export type MsTokenResponse = OAuthTokenResponse;

const handler = createOAuthHandler({
  name: "Microsoft",
  authorizeUrl: MS_OAUTH_AUTHORIZE_URL,
  tokenUrl: MS_OAUTH_TOKEN_URL,
  scope: MS_MAIL_SCOPE,
  startRoute: ROUTE_OAUTH_MICROSOFT_START,
  callbackRoute: ROUTE_OAUTH_MICROSOFT_CALLBACK,
  statePrefix: "ms:",
  extraAuthorizeParams: { response_mode: "query" },
  getCredentials: (env) => ({
    clientId: env.MS_CLIENT_ID as string,
    clientSecret: env.MS_CLIENT_SECRET as string,
  }),
  extraTokenBody: () => ({ scope: MS_MAIL_SCOPE }),
  fetchEmail: async (accessToken) => {
    const profile = (await http
      .get(`${MS_GRAPH_API}/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .json()) as {
      mail?: string;
      userPrincipalName?: string;
    };
    return profile.mail || profile.userPrincipalName;
  },
  onAuthorized: async (env, account) => {
    const provider = new OutlookProvider(account, env);
    await provider.renewPush();
    console.log(`Outlook subscription activated for ${account.email}`);
  },
});

export const { getOAuthPageProps, generateOAuthUrl, processOAuthCallback } =
  handler;
export const startMicrosoftOAuth = handler.startOAuth;
