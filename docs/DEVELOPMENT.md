# 本地开发

## 目录结构

仓库根是 pnpm workspace 容器（只放编排脚本 + biome / husky），两个子包：

- **`worker/`** —— Cloudflare Worker（Hono）。pnpm workspace 子包 `telemail-worker`。Bot webhook、queue consumer、cron、email providers、D1 / KV 访问、`/api/*` + `/oauth/*` 端点。`wrangler.jsonc`、`worker-configuration.d.ts`、`migrations/`、`tsconfig.json` 都在这里。
- **`page/`** —— Cloudflare Pages 前端（Vite + React 19 + TanStack Router + TanStack Query + HeroUI）。pnpm workspace 子包 `telemail-page`。web 页面（`/`、`/mail/:id`、`/preview`、`/junk-check`、`/login`）和 Mini App 路由（`/telegram-app/*`）共用同一个 `index.html` + `main.tsx`。

## 命令

根目录命令（推荐）：

```sh
# 后端（Worker）
pnpm dev:worker            # wrangler dev（本地 127.0.0.1:8787）
pnpm deploy:worker         # wrangler deploy
pnpm typegen:worker        # 根据 worker/wrangler.jsonc 重新生成 worker-configuration.d.ts
pnpm migrate:worker:remote # 应用 D1 migrations 到远端
pnpm migrate:worker:local  # 应用 D1 migrations 到本地 miniflare D1

# 前端（Pages）
pnpm dev:page              # Vite dev server (127.0.0.1:5173)，/api/* 自动代理到本地 Worker
pnpm build:page            # 构建到 page/dist

# 本地登录辅助（详见下面"本地测 web 登录页"）
pnpm dev:cookie            # 用 .dev.vars 里的 ADMIN_SECRET 签 session cookie
pnpm dev:seed              # 把 ADMIN_TELEGRAM_ID 写入本地 D1 users 表

# 共用
pnpm check                 # Biome lint + 格式检查（pre-commit 自动触发，覆盖全仓库）
pnpm typecheck             # pnpm -r typecheck（worker tsc + page tsc）
```

也可以直接进子包跑（worker 包里 `pnpm dev` / `pnpm deploy` 等是无前缀短名）。

Zed 用户：`.zed/tasks.json` 已经配好上述常用任务，cmd-shift-p → "task: spawn" 选择即可。

## 前端开发流程

1. 一个终端跑 `pnpm dev:worker`（Worker 起在 :8787）
2. 另一个终端跑 `pnpm dev:page`（Vite 起在 :5173）
3. 浏览器开 <http://localhost:5173/telegram-app/> 测 Mini App 页，或 `/mail/:id` / `/preview` 等 web 页，`/api/*` 自动代理到本地 Worker
4. TG WebApp 相关功能（`initData`、`BackButton`、`HapticFeedback`、`requestFullscreen` 等）在本地浏览器里 `TelegramProvider` 会检测到 `initData` 为空后 no-op；要测这些得在 Telegram 客户端里连真实 Bot

## 本地测 web 登录页（`/preview`、`/junk-check`）

这两个页面靠 `tg_session` cookie 鉴权，cookie 由生产环境里 Telegram Login Widget 走完 callback 后由 Worker 颁发。本地浏览器 `localhost` 加载不了 widget（Telegram 要求 `data-auth-url` 域名匹配 BotFather `/setdomain`），所以本地测的办法是**自己签一份 cookie 塞进去**。

一次性 setup：

1. **拿到自己的 Telegram user id**：在生产 bot 私聊里发 `/secrets`，`ADMIN_TELEGRAM_ID` 那一行就是（消息 60 秒后自销毁）。
2. **创建 `worker/.dev.vars`**（`.gitignore` 内）：

   ```
   ADMIN_SECRET=local-dev-secret-pick-anything
   ADMIN_TELEGRAM_ID=<你的TG id>
   ```

   `ADMIN_SECRET` 不要和生产共用 —— 本地 cookie 跟生产 cookie 完全独立，用任意字符串即可。要测 `/junk-check` 再加 `LLM_API_URL` / `LLM_API_KEY` / `LLM_MODEL`。
3. **灌本地 D1 schema**：`pnpm migrate:worker:local`
4. **seed admin 用户**：`pnpm dev:seed`（`requireTelegramLogin` 即使是 admin 也要求 `users` 表里有 row）

每次进浏览器测：

1. `pnpm dev:worker` + `pnpm dev:page`
2. `pnpm dev:cookie` —— 打印一行 `document.cookie = "..."`
3. 浏览器打开 `http://localhost:5173/preview`，F12 → Console 粘上面那行回车，刷新

cookie 有效期 7 天。改 `ADMIN_SECRET` 或换 `ADMIN_TELEGRAM_ID` 后要重签。

> Mini App 路由（`/telegram-app/*`）需要 `X-Telegram-Init-Data` 头，浏览器里没法伪造（HMAC 用 bot token 签），只能在真实 Telegram 客户端 + 公网隧道下测。这部分见 [DEPLOYMENT.md](./DEPLOYMENT.md) 里的 cloudflared 隧道 + dev bot 流程。

## 提交前必跑

```sh
pnpm check
pnpm typecheck
```

修所有报错。不要用 `biome-ignore` 绕过 lint（少数明确无解的情况可以，写清楚为什么）。

## 国际化 (i18n)

用户可见字符串通过 [i18next](https://www.i18next.com/) 管理（`import { t } from "@i18n"`），翻译文件按模块拆分在 `worker/i18n/locales/zh/` 下。当前仅中文。

## 类型共享

两个子包通过 tsconfig + vite 别名互引，但只走纯字符串常量 / 类型，从不跨包拖运行时代码。

- `page/tsconfig.json` + `page/vite.config.ts` 配 `@worker/*` → `../worker/*`：page 用 `import type` 引 worker 类型，从 `@worker/handlers/hono/routes`（零 import 的纯字符串常量文件）按需 import API 路径常量。
- `worker/tsconfig.json` 配 `@page/*` → `../page/src/*`：worker bot handlers（`bot/handlers/start.ts`、`mail-list.ts`）从 `@page/paths` import Mini App UI 路径常量，用来拼 `web_app` 按钮 URL。

不要从 page 拉 worker 里有副作用 / 运行时 deps 的代码，会被 Vite 打进前端 bundle；反向同理。

## 测试

```sh
pnpm exec vitest
```

测试配置在 `worker/` 子包里，用 `@cloudflare/vitest-pool-workers` 在本地模拟 Worker 环境（在 `worker/` 目录下跑 `pnpm exec vitest`）。
