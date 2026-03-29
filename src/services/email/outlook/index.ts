import { getAllAccounts } from "@db/accounts";
import {
  deleteMsSubscription,
  getCachedAccessToken,
  getMsSubscriptionId,
  putCachedAccessToken,
  putMsSubscription,
  refreshMsSubAccountMapping,
} from "@db/kv";
import type { MsTokenResponse } from "@services/email/outlook/oauth";
import { http } from "@utils/http";
import { HTTPError } from "ky";
import {
  MS_GRAPH_API,
  MS_MAIL_SCOPE,
  MS_OAUTH_TOKEN_URL,
  MS_SUBSCRIPTION_LIFETIME_MINUTES,
} from "@/constants";
import { type Account, AccountType, type Env } from "@/types";

// ─── Graph API response shapes ───────────────────────────────────────────────

interface GraphMessage {
  id: string;
  subject?: string;
  parentFolderId?: string;
  flag?: { flagStatus: string };
}

interface GraphMessageList {
  value?: GraphMessage[];
}

interface GraphFolder {
  id: string;
}

// ─── OAuth2 ──────────────────────────────────────────────────────────────────

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

  let data: MsTokenResponse;
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
      .json()) as MsTokenResponse;
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

// ─── REST helpers ────────────────────────────────────────────────────────────

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

/** 调用 Graph API (DELETE) */
export async function graphDelete(token: string, path: string): Promise<void> {
  await http.delete(`${MS_GRAPH_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
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

// ─── Message actions ─────────────────────────────────────────────────────────

/** 将邮件标记为已读 */
export async function markAsRead(
  token: string,
  messageId: string,
): Promise<void> {
  await graphPatch(token, `/me/messages/${messageId}`, { isRead: true });
}

/** 给邮件加星标（flag） */
export async function addStar(token: string, messageId: string): Promise<void> {
  await graphPatch(token, `/me/messages/${messageId}`, {
    flag: { flagStatus: "flagged" },
  });
}

/** 移除邮件星标 */
export async function removeStar(
  token: string,
  messageId: string,
): Promise<void> {
  await graphPatch(token, `/me/messages/${messageId}`, {
    flag: { flagStatus: "notFlagged" },
  });
}

/** 检查邮件是否已星标 */
export async function isStarred(
  token: string,
  messageId: string,
): Promise<boolean> {
  const msg = await graphGet<GraphMessage>(
    token,
    `/me/messages/${messageId}?$select=flag`,
  );
  return msg.flag?.flagStatus === "flagged";
}

/** 检查邮件是否在垃圾邮件文件夹 */
export async function isJunk(
  token: string,
  messageId: string,
): Promise<boolean> {
  const msg = await graphGet<GraphMessage>(
    token,
    `/me/messages/${messageId}?$select=parentFolderId`,
  );
  if (!msg.parentFolderId) return false;
  const junkFolder = await graphGet<GraphFolder>(
    token,
    `/me/mailFolders('JunkEmail')?$select=id`,
  );
  return msg.parentFolderId === junkFolder.id;
}

/** 列出未读邮件（最多 top 条），含标题 */
export async function listUnreadMessages(
  token: string,
  top: number = 20,
): Promise<{ id: string; subject?: string }[]> {
  const data = await graphGet<GraphMessageList>(
    token,
    `/me/mailFolders('Inbox')/messages?$filter=isRead eq false&$select=id,subject&$top=${top}`,
  );
  if (!data.value) return [];
  return data.value.map((m) => ({ id: m.id, subject: m.subject }));
}

/** 列出星标邮件（最多 top 条），含标题 */
export async function listStarredMessages(
  token: string,
  top: number = 20,
): Promise<{ id: string; subject?: string }[]> {
  const data = await graphGet<GraphMessageList>(
    token,
    `/me/messages?$filter=flag/flagStatus eq 'flagged'&$select=id,subject&$top=${top}`,
  );
  if (!data.value) return [];
  return data.value.map((m) => ({ id: m.id, subject: m.subject }));
}

/** 列出垃圾邮件（最多 top 条），含标题 */
export async function listJunkMessages(
  token: string,
  top: number = 20,
): Promise<{ id: string; subject?: string }[]> {
  const data = await graphGet<GraphMessageList>(
    token,
    `/me/mailFolders('JunkEmail')/messages?$select=id,subject&$top=${top}`,
  );
  if (!data.value) return [];
  return data.value.map((m) => ({ id: m.id, subject: m.subject }));
}

/** 将邮件标记为垃圾邮件（移到 JunkEmail 文件夹） */
export async function markAsJunk(
  token: string,
  messageId: string,
): Promise<void> {
  await graphPost(token, `/me/messages/${messageId}/move`, {
    destinationId: "JunkEmail",
  });
}

/** 将垃圾邮件移回收件箱 */
export async function moveToInbox(
  token: string,
  messageId: string,
): Promise<void> {
  await graphPost(token, `/me/messages/${messageId}/move`, {
    destinationId: "Inbox",
  });
}

/** 移到回收站 */
export async function trashMessage(
  token: string,
  messageId: string,
): Promise<void> {
  await graphPost(token, `/me/messages/${messageId}/move`, {
    destinationId: "DeletedItems",
  });
}

/** 清空所有垃圾邮件（移到回收站） */
export async function trashAllJunk(token: string): Promise<number> {
  const data = await graphGet<GraphMessageList>(
    token,
    `/me/mailFolders('JunkEmail')/messages?$select=id&$top=100`,
  );
  if (!data.value || data.value.length === 0) return 0;
  const ids = data.value.map((m) => m.id);
  await Promise.all(
    ids.map((id) =>
      graphPost(token, `/me/messages/${id}/move`, {
        destinationId: "DeletedItems",
      }),
    ),
  );
  return ids.length;
}

// ─── Subscription (webhook) ──────────────────────────────────────────────────

/** 为单个账号创建/续订 Graph change notification subscription */
export async function renewSubscription(
  env: Env,
  account: Account,
): Promise<void> {
  if (!env.MS_WEBHOOK_SECRET) {
    throw new Error("MS_WEBHOOK_SECRET not configured");
  }
  const token = await getAccessToken(env, account);
  const workerUrl = env.WORKER_URL?.replace(/\/$/, "") || "";
  const notificationUrl = `${workerUrl}/api/outlook/push?secret=${env.MS_WEBHOOK_SECRET}`;

  const expiration = new Date(
    Date.now() + MS_SUBSCRIPTION_LIFETIME_MINUTES * 60 * 1000,
  ).toISOString();

  const ttl = MS_SUBSCRIPTION_LIFETIME_MINUTES * 60;

  // 先尝试查找已有 subscription
  const existingSubId = await getMsSubscriptionId(env.EMAIL_KV, account.id);

  if (existingSubId) {
    // 尝试续订
    try {
      const resp = await http.patch(
        `${MS_GRAPH_API}/subscriptions/${existingSubId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          json: { expirationDateTime: expiration },
          throwHttpErrors: false,
        },
      );
      if (resp.ok) {
        await refreshMsSubAccountMapping(
          env.EMAIL_KV,
          existingSubId,
          account.id,
          ttl,
        );
        console.log(`Outlook subscription renewed for ${account.email}`);
        return;
      }
      // 续订失败，创建新的
    } catch {
      // 续订失败，创建新的
    }
  }

  // 创建新 subscription
  let sub: { id: string };
  try {
    sub = (await http
      .post(`${MS_GRAPH_API}/subscriptions`, {
        headers: { Authorization: `Bearer ${token}` },
        json: {
          changeType: "created",
          notificationUrl,
          resource: "me/mailFolders('Inbox')/messages",
          expirationDateTime: expiration,
          clientState: env.MS_WEBHOOK_SECRET,
        },
      })
      .json()) as { id: string };
  } catch (err) {
    if (err instanceof HTTPError) {
      const text = await err.response.text();
      throw new Error(
        `Failed to create Graph subscription for ${account.email}: ${err.response.status} ${text}`,
      );
    }
    throw err;
  }
  await putMsSubscription(env.EMAIL_KV, account.id, sub.id, ttl);
  console.log(
    `Outlook subscription created for ${account.email}, id=${sub.id}`,
  );
}

/** 停止 subscription */
export async function stopSubscription(
  env: Env,
  account: Account,
): Promise<void> {
  const token = await getAccessToken(env, account);
  const subId = await getMsSubscriptionId(env.EMAIL_KV, account.id);
  if (!subId) return;

  try {
    await http.delete(`${MS_GRAPH_API}/subscriptions/${subId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // 删除失败不影响主流程
  }
  await deleteMsSubscription(env.EMAIL_KV, account.id);
  console.log(`Outlook subscription stopped for ${account.email}`);
}

/** 为所有已授权的 Outlook 账号续订 subscription */
export async function renewSubscriptionAll(env: Env): Promise<void> {
  const accounts = await getAllAccounts(env.DB);
  for (const account of accounts) {
    if (account.type !== AccountType.Outlook || !account.refresh_token)
      continue;
    await renewSubscription(env, account);
  }
}
