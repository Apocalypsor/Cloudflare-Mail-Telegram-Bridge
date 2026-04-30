import { http } from "@worker/clients/http";
import { getCachedAccessToken, putCachedAccessToken } from "@worker/db/kv";
import type { OAuthTokenResponse } from "@worker/providers/types";
import type { Account, Env } from "@worker/types";
import { HTTPError } from "ky";

/**
 * 用 refresh_token 交换 access_token（KV 缓存，按账号隔离）。
 * Gmail / Outlook 两个 OAuth provider 的刷新逻辑共用这一个实现——差异仅是
 * tokenUrl、client 凭据、以及 Outlook 需要塞 `scope`。
 */
export async function refreshAccessToken(
  env: Env,
  account: Account,
  opts: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    /** 额外的 form-encoded body 字段（Outlook 要塞 scope） */
    extraBody?: Record<string, string>;
    /** 错误前缀，用来区分是哪家 provider 的失败（例如 "MS "） */
    errorLabel?: string;
  },
): Promise<string> {
  const cached = await getCachedAccessToken(env.EMAIL_KV, account.id);
  if (cached) return cached;

  if (!account.refresh_token) {
    throw new Error(
      `Account ${account.email} has no refresh token. Authorize via OAuth first.`,
    );
  }

  const label = opts.errorLabel ?? "";
  let data: OAuthTokenResponse;
  try {
    data = (await http
      .post(opts.tokenUrl, {
        body: new URLSearchParams({
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          refresh_token: account.refresh_token,
          grant_type: "refresh_token",
          ...(opts.extraBody ?? {}),
        }),
      })
      .json()) as OAuthTokenResponse;
  } catch (err) {
    if (err instanceof HTTPError) {
      throw new Error(
        `${label}Token exchange failed for ${account.email}: ${await err.response.text()}`,
      );
    }
    throw err;
  }
  if (!data.access_token || !data.expires_in) {
    throw new Error(
      `${label}Token response missing access_token or expires_in`,
    );
  }
  await putCachedAccessToken(
    env.EMAIL_KV,
    account.id,
    data.access_token,
    Math.max(data.expires_in - 120, 60),
  );
  return data.access_token;
}
