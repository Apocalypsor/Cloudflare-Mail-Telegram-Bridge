import { getCachedAccessToken, putCachedAccessToken } from "@db/kv";
import type { OAuthTokenResponse } from "@providers/base";
import { http } from "@utils/http";
import { HTTPError } from "ky";
import { MS_GRAPH_API, MS_MAIL_SCOPE, MS_OAUTH_TOKEN_URL } from "@/constants";
import type { Account, Env } from "@/types";

/** 用 refresh_token 换 access_token，带 KV 缓存 */
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

  let data: OAuthTokenResponse;
  try {
    data = (await http
      .post(MS_OAUTH_TOKEN_URL, {
        body: new URLSearchParams({
          client_id: env.MS_CLIENT_ID as string,
          client_secret: env.MS_CLIENT_SECRET as string,
          refresh_token: account.refresh_token,
          grant_type: "refresh_token",
          scope: MS_MAIL_SCOPE,
        }),
      })
      .json()) as OAuthTokenResponse;
  } catch (err) {
    if (err instanceof HTTPError) {
      throw new Error(
        `MS token exchange failed for ${account.email}: ${await err.response.text()}`,
      );
    }
    throw err;
  }
  if (!data.access_token || !data.expires_in) {
    throw new Error("MS token response missing access_token or expires_in");
  }
  await putCachedAccessToken(
    env.EMAIL_KV,
    account.id,
    data.access_token,
    Math.max(data.expires_in - 120, 60),
  );

  return data.access_token;
}

/** 调用 Graph API (GET) */
export async function graphGet<T>(token: string, path: string): Promise<T> {
  return http
    .get(`${MS_GRAPH_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    .json() as Promise<T>;
}

/** 调用 Graph API (PATCH with JSON body) */
export async function graphPatch(
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  await http.patch(`${MS_GRAPH_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    json: body,
  });
}

/** 调用 Graph API (POST with JSON body) */
export async function graphPost<T = void>(
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const resp = await http.post(`${MS_GRAPH_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    json: body,
  });
  const text = await resp.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** 获取邮件的原始 MIME 内容 */
export async function fetchRawMime(
  token: string,
  messageId: string,
): Promise<ArrayBuffer> {
  return http
    .get(`${MS_GRAPH_API}/me/messages/${messageId}/$value`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    .arrayBuffer();
}
