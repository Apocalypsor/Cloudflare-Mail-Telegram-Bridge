import { env as cfEnv } from "cloudflare:workers";
import type { Env } from "@worker/types";
import { Elysia } from "elysia";

/**
 * 把 Cloudflare Workers 的 (request, env, ctx) 注入到 Elysia context：
 *  - `env` 来自 `cloudflare:workers` 全局，模块级一次性 decorate（每次请求共享）
 *  - `executionCtx` / `waitUntil` 来自 per-request 的 `ExecutionContext`，
 *    通过 `worker/index.ts` 的 fetch wrapper 把 ctx 挂到 request 上，
 *    derive 时取出来
 *
 * 使用方式：所有需要 env 或 waitUntil 的 plugin / module 都 `.use(cf)`。
 * 由于 plugin 用 `name: "cf"`，重复 use 自动 dedupe。
 */
export type RequestWithCtx = Request & { _ctx?: ExecutionContext };

const env = cfEnv as unknown as Env;

export const cf = new Elysia({ name: "cf" })
  .decorate("env", env)
  .derive({ as: "scoped" }, ({ request }) => {
    const ctx = (request as RequestWithCtx)._ctx;
    if (!ctx) {
      throw new Error(
        "ExecutionContext not injected — fetch wrapper missing _ctx",
      );
    }
    return {
      executionCtx: ctx,
      waitUntil: ctx.waitUntil.bind(ctx),
    };
  });
