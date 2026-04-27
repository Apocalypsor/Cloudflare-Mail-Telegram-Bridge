#!/usr/bin/env node
/**
 * 把 worker/.dev.vars 里的 ADMIN_TELEGRAM_ID 写入本地 D1 的 users 表。
 * 用 INSERT OR IGNORE，重复跑无副作用。requireTelegramLogin middleware 要
 * 在 users 表里有 row（即使是 admin 也躲不过这个检查），所以这一步是
 * /preview 等需要登录的本地页面能跑起来的前提。
 *
 * 跑这个脚本前先跑 `bun migrate:worker:local` 把 schema 灌进本地 D1。
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDevVars } from "./_dev-vars.mjs";

const env = loadDevVars(["ADMIN_TELEGRAM_ID"]);
const tgId = env.ADMIN_TELEGRAM_ID;

const sql = `INSERT OR IGNORE INTO users (telegram_id, first_name, approved) VALUES ('${tgId}', 'Dev', 1)`;
const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync(
  "bun",
  ["wrangler", "d1", "execute", "gmail-tg-bridge", "--local", "--command", sql],
  { cwd: workerDir, stdio: "inherit" },
);

if (result.status === 0) {
  console.log(`\n✅ 已 seed admin 用户（telegram_id=${tgId}）到本地 D1`);
}

process.exit(result.status ?? 1);
