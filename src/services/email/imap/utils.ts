import { http } from "@utils/http";
import { HTTPError } from "ky";
import type { Env } from "@/types";

/**
 * 检查 IMAP 中间件健康状态。
 * 返回 null 表示未配置 IMAP bridge（跳过检查）。
 */
export async function checkImapBridgeHealth(
  env: Env,
): Promise<{ ok: boolean; total: number; usable: number } | null> {
  if (!env.IMAP_BRIDGE_URL) return null;
  const url = `${env.IMAP_BRIDGE_URL.replace(/\/$/, "")}/api/health`;
  const resp = await http.get(url, { throwHttpErrors: false });
  return (await resp.json()) as { ok: boolean; total: number; usable: number };
}

/** 通知中间件重新拉取账号列表（账号增删后调用） */
export async function syncAccounts(env: Env): Promise<void> {
  await callBridge(env, "POST", "/api/sync");
}

/** IMAP bridge HTTP 请求封装 */
export async function callBridge(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  if (!env.IMAP_BRIDGE_URL || !env.IMAP_BRIDGE_SECRET) {
    throw new Error(
      "IMAP bridge not configured (missing IMAP_BRIDGE_URL or IMAP_BRIDGE_SECRET)",
    );
  }

  const url = `${env.IMAP_BRIDGE_URL.replace(/\/$/, "")}${path}`;
  try {
    return await http(url, {
      method,
      headers: { Authorization: `Bearer ${env.IMAP_BRIDGE_SECRET}` },
      ...(body !== undefined && { json: body }),
    });
  } catch (err) {
    if (err instanceof HTTPError) {
      const text = await err.response.text();
      throw new Error(
        `IMAP bridge ${method} ${path} failed (${err.response.status}): ${text}`,
      );
    }
    throw err;
  }
}
