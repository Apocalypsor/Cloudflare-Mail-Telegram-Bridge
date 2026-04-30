const _log = console.log;
const _err = console.error;
const ts = () => new Date().toISOString();
console.log = (...args: unknown[]) => _log(ts(), ...args);
console.error = (...args: unknown[]) => _err(ts(), ...args);

import { connectionManager } from "@middleware/imap";
import { junkController } from "@middleware/modules/junk/index";
import { mailController } from "@middleware/modules/mail/index";
import { syncController } from "@middleware/modules/sync/index";
import { Elysia } from "elysia";
import { config } from "./config";

/**
 * IMAP bridge HTTP app。Worker 端 Eden treaty 通过 `import type { App } from
 * "@middleware/index"` 拿这份类型，所有 `/api/...` 路由 / body / response
 * 都从这棵 `.use(...)` 链里推出来。
 */
export const app = new Elysia({ prefix: "/api" })
  .onError(({ error }) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(msg);
    return { ok: false, error: msg };
  })
  .use(syncController)
  .use(mailController)
  .use(junkController);

export type App = typeof app;

const main = async (): Promise<void> => {
  console.log("[Telemail Middleware] Starting...");

  app.listen(config.port, () => {
    console.log(`[Server] Listening on port ${config.port}`);
  });

  try {
    await connectionManager.sync();
  } catch (err: unknown) {
    console.error("[Startup] Failed to sync accounts:", err);
    console.error("[Startup] Will retry on next POST /sync call.");
  }

  process.on("SIGTERM", () => {
    console.log("[Telemail Middleware] Shutting down...");
    process.exit(0);
  });
};

main().catch((err) => {
  console.error("[Fatal]", err);
  process.exit(1);
});
