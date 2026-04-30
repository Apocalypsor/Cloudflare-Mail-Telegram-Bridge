import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// ─── Eden error helpers ─────────────────────────────────────────────────────

/** Eden treaty error shape: `{ status: number, value: unknown, response: Response }`. */
type EdenError = { status: number; value: unknown };

function isEdenError(err: unknown): err is EdenError {
  return (
    err != null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number" &&
    "value" in err
  );
}

/**
 * session-auth 页面（/preview, /junk-check）碰到 401 时：跳登录页带 return_to。
 * 返回 true 表示已经触发跳转，调用方应该立即终止后续处理。
 */
export function redirectToLoginOnUnauthorized(err: unknown): boolean {
  if (isEdenError(err) && err.status === 401) {
    const here = window.location.pathname + window.location.search;
    window.location.href = `/login?return_to=${encodeURIComponent(here)}`;
    return true;
  }
  return false;
}

/** 从 Eden / Error 错误里挖 error 字段；拿不到就用 HTTP status 文本兜底 */
export async function extractErrorMessage(err: unknown): Promise<string> {
  if (isEdenError(err)) {
    const v = err.value;
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object") {
      const msg = (v as { error?: unknown }).error;
      if (typeof msg === "string" && msg) return msg;
    }
    return `HTTP ${err.status}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Route search-param validator ──────────────────────────────────────────

/**
 * TanStack Router `validateSearch` 的 TypeBox 适配器 —— 跟 worker / middleware
 * 同一套 schema runtime（Elysia 的 `t`），page 这边复用一份。
 *
 * 流水线：
 *   1. `Value.Clean` —— 丢 schema 未声明的字段
 *   2. `Value.Convert` —— `?id=123` → `id: 123`、`?cache=true` → `cache: true`
 *   3. **逐字段 `Value.Check`，类型不匹配的（包括 t.Optional 里塞了脏值）直接 delete** ——
 *      还原老 zod 时代 `fallback(...)` 的"脏 URL 不炸页"语义
 *   4. `Value.Parse` —— 必填字段还缺就抛（TanStack 走 errorComponent）
 *
 * 用法：
 * ```ts
 * const Search = t.Object({ accountId: t.Number(), t: t.String() })
 * createFileRoute("/mail/$id/")({ validateSearch: validateSearch(Search) })
 * ```
 *
 * `t.Optional(...)`：缺失或脏值都视作 undefined（key 不出现在解析结果里）；
 * 必填字段缺失或类型对不上 → 抛 → errorComponent。
 */
export function validateSearch<T extends TSchema>(
  schema: T,
): (input: Record<string, unknown>) => Static<T> {
  return (input) => {
    const cleaned = Value.Clean(schema, { ...input });
    const converted = Value.Convert(schema, cleaned) as Record<string, unknown>;
    if (converted && typeof converted === "object" && "properties" in schema) {
      const properties = (
        schema as unknown as { properties: Record<string, TSchema> }
      ).properties;
      for (const key of Object.keys(converted)) {
        const fieldSchema = properties[key];
        if (fieldSchema && !Value.Check(fieldSchema, converted[key])) {
          delete converted[key];
        }
      }
    }
    return Value.Parse(schema, converted) as Static<T>;
  };
}
