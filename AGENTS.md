# Cloudflare Workers

> Before committing, run `pnpm check` (Biome) and `pnpm typecheck` (tsc). Fix ALL errors. Do NOT use `biome-ignore`. Update AGENTS.md / README.md / `docs/*` if needed.

User-facing docs are split:

- `README.md` —— landing, stack, architecture overview, bot commands
- `docs/DEVELOPMENT.md` —— local dev commands + flow
- `docs/DEPLOYMENT.md` —— end-to-end CF deploy (GCP / MS Entra / D1 / KV / Queue / Worker + Pages)
- `docs/ENVIRONMENT.md` —— secrets / bindings / cron / D1 schema reference

Your knowledge of Cloudflare Workers APIs may be outdated. Retrieve current docs before any Workers/KV/D1/Queues task: <https://developers.cloudflare.com/workers/>

## Commands

Root is pure orchestration (workspaces: `worker/` + `page/`). All commands run from repo root unless noted.

| Command                       | Purpose                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `pnpm dev:worker`             | `wrangler dev` (Worker, port 8787)                       |
| `pnpm dev:page`               | Vite dev server for `page/` (port 5173, proxies /api)    |
| `pnpm dev:cookie`             | Sign a local `tg_session` cookie from `worker/.dev.vars` |
| `pnpm dev:seed`               | Seed `ADMIN_TELEGRAM_ID` into local D1 `users` (admin row) |
| `pnpm deploy:worker`          | `wrangler deploy` (deploy Worker to Cloudflare)          |
| `pnpm build:page`             | Build React SPA (`page/` → `page/dist`, deploy to Pages) |
| `pnpm migrate:worker:remote`  | Apply D1 migrations (remote)                             |
| `pnpm migrate:worker:local`   | Apply D1 migrations (local miniflare)                    |
| `pnpm typegen:worker`         | Generate `worker-configuration.d.ts` from wrangler.jsonc |
| `pnpm check`                  | Biome lint + format (single config covers all packages)  |
| `pnpm typecheck`              | tsc on worker + page (`pnpm -r typecheck`)               |

Run `pnpm typegen:worker` after changing bindings in `worker/wrangler.jsonc`.

## Project layout

- **`worker/`** — Cloudflare Worker (Hono): bot webhook, queue consumer, cron, email providers, D1 access, `/api/*` + `/oauth/*` endpoints. pnpm workspace child package `telemail-worker`. Owns `wrangler.jsonc`, `worker-configuration.d.ts`, `migrations/`, `tsconfig.json`. (`/mail/:id`, `/preview`, `/junk-check`, `/login` HTML 页面在 Pages，不在 Worker。)
- **`page/`** — Cloudflare Pages frontend (Vite + React 19 + TanStack Router + TanStack Query + ky + zod + HeroUI). pnpm workspace child package `telemail-page`. **Single entry**: `index.html` + `src/main.tsx` + `src/routes/` 供 web 页面（`/`、`/mail/:id`、`/preview`、`/junk-check`、`/login`）和 Mini App 路由（`/telegram-app/*`）共享。TG SDK 无条件加载，`TelegramProvider` 在非 TG 上下文下（`initData` 为空）跳过所有 TG 初始化调用。样式统一走 `src/styles/app.css` = `@import "@heroui/styles"` + `./theme.css`（固定深色 zinc/emerald palette，映射到 HeroUI 设计 token）。
- **Deployment (方案 A)**: single custom domain, Workers Routes split by path. `example.com/api/*`, `example.com/oauth/*` → Worker; everything else (incl. `/mail/:id`, `/preview`, `/junk-check`, `/telegram-app/*`, `/login`, `/`) → Pages。Pages `_redirects` 把所有 SPA 路径 rewrite 到 `/index.html`。`WORKER_URL` and BotFather `/setdomain` point at the root domain.

## Conventions

- **Layering**: `worker/handlers/` only do routing / auth / req-resp shaping; business logic lives in `worker/services/` or on a provider method.
- **Helpers**: if a helper is used by only ONE file, keep it file-private next to its caller. If used by MULTIPLE files, lift it to the nearest `utils/` dir — `worker/utils/` for cross-cutting helpers, `worker/bot/utils/` / `worker/providers/<p>/utils.ts` for layer-scoped ones. Same goes for deduping: if you spot the same logic copy-pasted in two places (HMAC signing, OAuth refresh, etc.), extract it rather than keeping both.
- **Shared types**: shared interfaces / types go in `worker/types.ts` (cross-cutting) or a colocated `types.ts` (module-scoped, e.g. `providers/types.ts`, `providers/outlook/types.ts`). Don't inline reusable types into handlers/services.
- **Error reporting**: use `reportErrorToObservability()`, not `console.error`.
- **Email providers**: abstract class in `worker/providers/base.ts`, shared interfaces in `worker/providers/types.ts`, barrel in `worker/providers/index.ts` (exports `PROVIDERS`, `getEmailProvider`, `accountCanArchive`). Each concrete provider (`gmail/`, `outlook/`, `imap/`) has its own `index.ts` class + `utils.ts` + optional `types.ts`.
- **Provider polymorphism**: never branch on `account.type` outside `providers/`. Per-provider differences live on the class — static metadata (`displayName`, `oauth`, `canArchive`), instance methods (fetch / list / archive / push / `resolveMessageState` / `onPersistedChange`), and `static registerRoutes(app)` for webhooks (so adding a provider needs no handler wiring).
- **IMAP message ids = RFC 822 Message-Id** (not per-folder UID). The bridge API takes `rfcMessageId` and `SEARCH HEADER Message-Id`s to resolve the current UID. Emails without Message-Id are dropped. Gmail/Outlook keep native ids.
- **Archive**: `provider.archiveMessage(messageId)` + `accountCanArchive(account)`. Gmail requires the user to pick a label (stored in `accounts.archive_folder` + `accounts.archive_folder_name`); without it `canArchive()` returns false.
- **State reconciliation**: all "remote → TG" syncs funnel through `reconcileMessageState` (`services/message-actions.ts`), which uses `provider.resolveMessageState` and either removes the TG msg (non-inbox) or syncs star/pin (inbox).
- **Star pin**: ⭐ email ↔ pinned TG msg. Single entry point: `syncStarPinState` in `services/message-actions.ts`. A `pin-cleanup` handler deletes TG's "Bot pinned" service messages.
- **Disable/enable**: `accounts.disabled` pauses without deleting. Enforced in `services/bridge.ts::processEmailMessage` (queue consumer) + filtered in push renewal / mail-list / `/sync` / `getImapAccounts`.
- **Cron**: single `* * * * *` trigger. `handleScheduled` (`worker/handlers/scheduled.ts`, parallel to `handlers/queue.ts`) dispatches due reminders every minute; `getUTCMinutes() === 0` gates the hourly batch (retry / IMAP bridge health); midnight additionally renews pushes.
- **Mail preview helpers** (CID inlining, image proxy rewriting, token signing) live in `worker/services/mail-preview.ts`.
- **Mini App 路由** (`page/src/routes/telegram-app/`): HeroUI + TG 原生控件（MainButton / SecondaryButton / BackButton），样式跟 web 页共用 zinc/emerald。iPad 上自动 `requestFullscreen()`（Bot API 8.0+），TG 顶栏收成浮动 pill。
  - `/telegram-app/` → `index.tsx` router entry, reads `window.Telegram.WebApp.initDataUnsafe.start_param` (`r_<chat>_<msg>` / `m_<chat>_<msg>`) and navigates.
  - `/telegram-app/reminders` → set/list/cancel reminders.
  - `/telegram-app/mail/$id` → email preview (fetches JSON from `GET /api/mail/:id` —— token-only auth, shared with web `/mail/$id`; renders body in sandbox iframe via `MailBodyFrame`, shows `MailFab` for star/archive/trash/junk/unarchive). API 返回 `bodyHtml`（CORS 代理改写过，默认渲染）+ `bodyHtmlRaw`（未改写原始 HTML），父路由 hold `useProxy` state 传给 `MailBodyFrame`；切换入口：web 在 `WebMailToolbar` 里和「标记为垃圾」并排的「🖼 图片代理 开/关」按钮，miniapp 把 `MailFab` 的 SecondaryButton 直接当 toggle（文案 `🖼 关闭/开启图片代理` 跟 state 走，单击即切换 + light haptic），不再走「更多」popup。所有平台（含 macOS / Telegram Desktop）一律在 Mini App 内打开，不再做桌面 → 浏览器跳转。
  - `/telegram-app/list/$type` → unread/starred/junk/archived lists.
  - `/telegram-app/search` → cross-account 邮件搜索（关键词 / 发件人 / 主题；Gmail / Outlook 走原生搜索语法）。
- **Web 页面** (`page/src/routes/`，不在 `telegram-app/` 子目录下): 浏览器里直接访问的页面，`WebLayout` 套 sticky emerald wordmark header，HeroUI Card / Button 做现代化外观。
  - `/mail/$id` → 浏览器里看邮件（HMAC token-only auth，不需要 initData）。
  - `/preview` → HTML → MarkdownV2 预览（session cookie + `useRequireTelegramLogin`）。
  - `/junk-check` → 垃圾邮件检测（同上）。
  - `/login` → Telegram Login Widget（denial 态由 Worker callback 302 带 `?denied=1&uid=` 回来）。
  - `/` → Landing 兜底页。
  - **Bot keyboard URLs** (`worker/utils/mail-token.ts`, `worker/bot/handlers/*`) still point at `/telegram-app/*` — intentional: those are the Mini App URLs registered in BotFather. Pages is configured to serve the SPA at those paths (or redirect from `/` → root). Private chat buttons are inline `web_app` pointing at subpage URLs; group chat uses `t.me/<bot>/<short>?startapp=<feature>_<chat>_<msg>` deep links which land on `/` router.
  - **Auth**: every API call goes through `page/src/api/client.ts` (ky instance) which injects `X-Telegram-Init-Data` when in TG context. Worker `requireMiniAppAuth` verifies. Session cookie for browser pages. Mail preview API also checks HMAC token.
  - **Cross-package imports**: `page/tsconfig.json` + `page/vite.config.ts` alias `@worker/*` → `../worker/*`; `worker/tsconfig.json` alias `@page/*` → `../page/src/*`. Both directions only carry pure-string constants / types — never runtime code:
    - Page → Worker: types (`import type`) and route constants from `@worker/handlers/hono/routes` (zero-dep file).
    - Worker → Page: Mini App route paths from `@page/paths` (used by bot keyboards in `worker/bot/handlers/start.ts` / `mail-list.ts` to build `web_app` URLs).
- **Email keyboard**: `buildEmailKeyboard` requires `tgMessageId`, so `deliverEmailToTelegram` sends the message naked, inserts `message_map`, then builds the keyboard and attaches it via `setReplyMarkup` — one code path for private + group. All other rebuild sites (refresh, toggle-star, reminder change, junk cancel) already have `tgMessageId`.
- **Reminders**: entry is exclusively through the ⏰ button on email messages (no `/remind` command). Auth on every API: `X-Telegram-Init-Data` via `utils/tg-init-data.ts::verifyTgInitData` + `users.approved`. Group deep-link resolve-context also checks `account.telegram_user_id === current user` (only the account owner can set reminders). Cron sends with `reply_parameters` so the reminder threads under the original email even if deleted.
  Setup: `WORKER_URL` env, BotFather `/setdomain`, `/newapp` to register the Mini App (so `?startapp=` works for group deep links).
