import { treaty } from "@elysiajs/eden";
import type { App as MiddlewareApp } from "@middleware/index";
import type { Env } from "@worker/types";

/**
 * IMAP middleware Eden treaty client。所有 `/api/*` 路由的 path / body / response
 * 都从 `@middleware/index` 自动推导。
 *
 * `throwHttpError: true` 让 Eden 在非 2xx 时直接抛 `EdenFetchError`（`extends Error`，
 * 带 `.status` / `.value`）。`reportErrorToObservability` 那一头识别这个 shape
 * 把 message 拼成可读形式；这里就用原版 treaty，不再单独包一层。
 */
export function bridgeClient(env: Env) {
  if (!env.IMAP_BRIDGE_URL || !env.IMAP_BRIDGE_SECRET) {
    throw new Error(
      "IMAP bridge not configured (missing IMAP_BRIDGE_URL or IMAP_BRIDGE_SECRET)",
    );
  }
  return treaty<MiddlewareApp>(env.IMAP_BRIDGE_URL.replace(/\/$/, ""), {
    headers: { Authorization: `Bearer ${env.IMAP_BRIDGE_SECRET}` },
    throwHttpError: true,
  });
}

/**
 * 拆 treaty 的 success branch。`throwHttpError: true` 已保证非 2xx 抛错，
 * 运行时 `data` 一定非 null —— 这里仅把 TS 的 `T | null` 收紧成 `T`。
 */
export async function bridgeCall<T>(
  p: Promise<{ data: T | null }>,
): Promise<NonNullable<T>> {
  const { data } = await p;
  return data as NonNullable<T>;
}

/**
 * 检查 IMAP 中间件健康状态。
 * 返回 null 表示未配置 IMAP bridge（跳过检查）。
 * 抛出 / 5xx / 不可达 → 返回 ok: false 占位（health 探测吞错，避免拖累调用方）。
 */
export async function checkImapBridgeHealth(
  env: Env,
): Promise<{ ok: boolean; total: number; usable: number } | null> {
  if (!env.IMAP_BRIDGE_URL) return null;
  try {
    return await bridgeCall(bridgeClient(env).api.health.get());
  } catch {
    return { ok: false, total: 0, usable: 0 };
  }
}

/** 通知中间件重新拉取账号列表（账号增删后调用） */
export async function syncAccounts(env: Env): Promise<void> {
  await bridgeClient(env).api.sync.post();
}
