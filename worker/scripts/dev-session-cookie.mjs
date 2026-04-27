#!/usr/bin/env node
/**
 * 本地开发签 session cookie。
 *
 * 用法：在 worker/ 下跑 `bun dev:cookie`。脚本读 worker/.dev.vars 里的
 * ADMIN_SECRET / ADMIN_TELEGRAM_ID，签出和 worker/utils/session.ts 完全
 * 一致的 cookie，打印一段可直接粘到浏览器 DevTools Console 的代码。
 *
 * Cookie 格式（与 generateSessionCookie 对齐）：
 *   tg_session=<telegramId>:<timestamp>:<hmac32>
 *   hmac32 = HMAC-SHA256(ADMIN_SECRET, "<telegramId>:<timestamp>") 取前 32 hex
 */
import { createHmac } from "node:crypto";
import { loadDevVars } from "./_dev-vars.mjs";

const env = loadDevVars(["ADMIN_SECRET", "ADMIN_TELEGRAM_ID"]);

const ts = Math.floor(Date.now() / 1000);
const payload = `${env.ADMIN_TELEGRAM_ID}:${ts}`;
const hmac = createHmac("sha256", env.ADMIN_SECRET)
  .update(payload)
  .digest("hex")
  .slice(0, 32);
const cookieValue = `${payload}:${hmac}`;

const sevenDays = 7 * 24 * 3600;
console.log(`
✅ 已生成 dev session cookie（telegram_id=${env.ADMIN_TELEGRAM_ID}）

在你要测的页面（比如 http://localhost:5173/preview）打开 DevTools Console，
粘下面这一行回车，然后刷新页面：

document.cookie = "tg_session=${cookieValue}; path=/; max-age=${sevenDays}; SameSite=Lax";

cookie 有效期 7 天（和生产 SESSION_TTL 一致）。重启 worker / 改 ADMIN_SECRET 后需要重签。
`);
