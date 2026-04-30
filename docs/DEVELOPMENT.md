# 本地开发

## 首次 setup

`worker/wrangler.jsonc` **是 gitignored 的**（含 CF 账号专属 ID）。clone 后第一次跑：

```sh
cp worker/wrangler.example.jsonc worker/wrangler.jsonc
# 编辑 wrangler.jsonc，把 ${D1_DATABASE_ID} / ${KV_NAMESPACE_ID} 换成
# bun wrangler d1 create / kv namespace create 返回的真实 ID
bun typegen:worker            # 重新生成 worker-configuration.d.ts
bun install
```

CI 自己走 `envsubst` 用 repo secrets 生成 `wrangler.jsonc`，本地不需要装 envsubst。

## 目录结构

仓库根是 bun workspace 容器，三个子包：

- **`worker/`** —— Cloudflare Worker（Elysia + grammY）。Bot webhook、queue consumer、cron、email providers、D1 / KV、`/api/*` + `/oauth/*`。`wrangler.jsonc` / `migrations/` 在这里。
- **`page/`** —— Cloudflare Pages SPA（Vite + React 19 + TanStack Router/Query + HeroUI + Eden treaty）。web 页面（`/`、`/mail/:id`、`/preview`、`/junk-check`、`/login`）和 Mini App 路由（`/telegram-app/*`）共用同一个 `index.html` + `main.tsx`。
- **`middleware/`** —— IMAP bridge（Bun + Elysia + ImapFlow）。**不部署到 Cloudflare**，docker 跑在自己服务器上。`bun build --compile` 出单文件 binary，distroless 镜像。详见 [`DEPLOYMENT.md` §6.4](./DEPLOYMENT.md)。

## 命令（在仓库根跑）

```sh
# 起服务
bun dev:worker            # wrangler dev (127.0.0.1:8787)
bun dev:page              # vite (127.0.0.1:5173)，/api/* 自动代理到本地 Worker
bun dev:middleware        # bun --watch (127.0.0.1:3000)

# 部署 / 构建
bun deploy:worker         # wrangler deploy
bun build:page            # 构建到 page/dist
bun build:middleware      # bun build --compile → middleware/server

# Worker 杂项
bun typegen:worker        # 重新生成 worker-configuration.d.ts
bun migrate:worker:remote # D1 migrations → 远端
bun migrate:worker:local  # D1 migrations → 本地 miniflare

# 本地登录辅助（详见下面）
bun dev:cookie            # 用 .dev.vars 的 ADMIN_SECRET 签 session cookie
bun dev:seed              # 把 ADMIN_TELEGRAM_ID 写入本地 D1 users

# Lint / 类型 / 提交前必跑
bun check                 # Biome（pre-commit 自动触发）
bun typecheck             # tsc on worker + page + middleware
```

也可以进子包跑（`worker/` 里 `bun dev` / `bun deploy` 等是无前缀短名）。Zed 用户：`.zed/tasks.json` 已配好常用任务，cmd-shift-p → "task: spawn"。

## 前端开发流程

1. 一个终端跑 `bun dev:worker`（:8787）
2. 另一个终端跑 `bun dev:page`（:5173）
3. 浏览器开 <http://localhost:5173/telegram-app/> 测 Mini App，或 `/mail/:id` / `/preview` 等 web 页，`/api/*` 自动代理到本地 Worker
4. TG WebApp 的 `initData` / `BackButton` / `HapticFeedback` 等本地浏览器里 `TelegramProvider` 检测到 `initData` 空就 no-op；要测真实行为得在 Telegram 客户端里连真 Bot

## 本地测 web 登录页（`/preview`、`/junk-check`）

这两个页面靠 `tg_session` cookie 鉴权，cookie 由生产 Telegram Login Widget 走完 callback 后由 Worker 颁发。本地 `localhost` 加载不了 widget，所以要**自己签 cookie**。

一次性 setup：

1. **拿 Telegram user id**：在生产 bot 私聊里发 `/secrets`，找 `ADMIN_TELEGRAM_ID`（消息 60 秒后自销毁）。
2. **创建 `worker/.dev.vars`**（已 gitignore）：

   ```
   ADMIN_SECRET=local-dev-secret-pick-anything
   ADMIN_TELEGRAM_ID=<你的 TG id>
   ```

   `ADMIN_SECRET` 不要和生产共用 —— 本地 cookie 跟生产 cookie 完全独立。要测 `/junk-check` 再加 `LLM_API_URL` / `LLM_API_KEY` / `LLM_MODEL`。
3. **灌本地 D1 schema**：`bun migrate:worker:local`
4. **seed admin 用户**：`bun dev:seed`（`requireTelegramLogin` 即使 admin 也要求 `users` 表有 row）

每次进浏览器测：

1. `bun dev:worker` + `bun dev:page`
2. `bun dev:cookie` —— 打印一行 `document.cookie = "..."`
3. 浏览器开 `http://localhost:5173/preview`，DevTools Console 粘那行回车，刷新

cookie 7 天有效。改 `ADMIN_SECRET` 或 `ADMIN_TELEGRAM_ID` 后要重签。

> Mini App 路由（`/telegram-app/*`）需要 `X-Telegram-Init-Data`（HMAC 用 bot token 签），浏览器伪造不了。要测得在真实 Telegram 客户端 + cloudflared 隧道下连 dev bot —— 见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 跨包导入

仓库统一只用三个 TS path alias：`@page/*` `@worker/*` `@middleware/*`，全部声明在根 `tsconfig.base.json`（每个子 tsconfig 通过 `extends` 继承）。各包内部一律用带前缀的全路径（`@worker/db/...` `@page/components/...` `@middleware/imap` 等），没有 `@db/*` `@components/*` 这种短 alias。

跨包只走 **类型 + 字符串常量**，从不跨包拖运行时代码：

- `page/` 用 `import type { App } from "@worker/api"` 配 Eden treaty 拿端到端类型（Mini App 路径常量从 `@page/paths` 自己出）
- `worker/` 用 `import type { App } from "@middleware/index"` 配 Eden treaty 调 IMAP bridge；用 `import { ROUTE_MINI_APP_* } from "@page/paths"` 拼 `web_app` 按钮 URL

任何从 page 拉 worker 运行时代码（非 type-only import）都会被 Vite 打进前端 bundle —— 反向同理。

## i18n

用户可见字符串走 [i18next](https://www.i18next.com/)（`import { t } from "@worker/i18n"`），翻译文件按模块拆在 `worker/src/i18n/locales/zh/`。当前仅中文。
