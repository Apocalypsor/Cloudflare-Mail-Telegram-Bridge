import { getCachedAccessToken, putCachedAccessToken } from "@db/kv";
import type { GoogleTokenResponse } from "@services/email/gmail/oauth";
import { http } from "@utils/http";
import { HTTPError } from "ky";
import { GMAIL_API, GOOGLE_OAUTH_TOKEN_URL } from "@/constants";
import type { Account, Env } from "@/types";

/** 用 refresh_token 换 access_token，带 KV 缓存（按账号隔离） */
export async function getAccessToken(
  env: Env,
  account: Account,
): Promise<string> {
  const cached = await getCachedAccessToken(env.EMAIL_KV, account.id);
  if (cached) return cached;

  if (!account.refresh_token) {
    throw new Error(
      `Account ${account.email} has no refresh token. Authorize via OAuth first.`,
    );
  }

  let data: GoogleTokenResponse;
  try {
    data = (await http
      .post(GOOGLE_OAUTH_TOKEN_URL, {
        body: new URLSearchParams({
          client_id: env.GMAIL_CLIENT_ID,
          client_secret: env.GMAIL_CLIENT_SECRET,
          refresh_token: account.refresh_token,
          grant_type: "refresh_token",
        }),
      })
      .json()) as GoogleTokenResponse;
  } catch (err) {
    if (err instanceof HTTPError) {
      throw new Error(
        `Token exchange failed for ${account.email}: ${await err.response.text()}`,
      );
    }
    throw err;
  }
  if (!data.access_token || !data.expires_in) {
    throw new Error("Token response missing access_token or expires_in");
  }
  await putCachedAccessToken(
    env.EMAIL_KV,
    account.id,
    data.access_token,
    Math.max(data.expires_in - 120, 60),
  );

  return data.access_token;
}

/** 调用 Gmail REST API (GET) */
export async function gmailGet<T>(token: string, path: string): Promise<T> {
  return http
    .get(`${GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    .json() as Promise<T>;
}

/** 调用 Gmail REST API (POST with JSON body) */
export async function gmailPost<T = void>(
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const resp = await http.post(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    json: body,
  });
  const text = await resp.text();
  return (text ? JSON.parse(text) : null) as T;
}
