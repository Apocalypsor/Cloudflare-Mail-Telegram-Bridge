# Cloudflare Workers

> Before committing, run `pnpm check` (Biome) and `pnpm typecheck` (tsc). Fix ALL errors. Do NOT use `biome-ignore`. Update AGENTS.md and README.md if needed.

Your knowledge of Cloudflare Workers APIs may be outdated. Retrieve current docs before any Workers/KV/D1/Queues task: <https://developers.cloudflare.com/workers/>

## Commands

| Command           | Purpose                                               |
| ----------------- | ----------------------------------------------------- |
| `pnpm dev`        | Build CSS + wrangler dev (Worker, port 8787)          |
| `pnpm dev:web`    | Vite dev server for `web/` (port 5173, proxies /api)  |
| `pnpm deploy`     | Build CSS + deploy Worker to Cloudflare               |
| `pnpm build:web`  | Build React SPA (`web/` → `web/dist`, deploy to Pages)|
| `pnpm check`      | Lint + format check (Biome, root + web)               |
| `pnpm typecheck`  | Worker tsc + web tsc                                  |
| `pnpm cf-typegen` | Generate TypeScript types from wrangler.jsonc         |
| `pnpm build:css`  | Generate Tailwind CSS (src/assets/tailwind.ts)        |

Run `pnpm cf-typegen` after changing bindings in wrangler.jsonc.

## Project layout

- **`src/`** — Cloudflare Worker (Hono): bot webhook, queue consumer, cron, email providers, D1 access, `/api/*` + `/mail/:id` + `/oauth/*` + `/login*` pages.
- **`web/`** — Cloudflare Pages frontend (Vite + React 19 + TanStack Router + TanStack Query + ky + zod). pnpm workspace child package `telemail-web`. **Multi-entry**: two independent bundles from one Vite build — `miniapp.html` + `src/main-miniapp.tsx` + `src/routes-miniapp/` (TG SDK, TG 主题, HeroUI) and `index.html` + `src/main-web.tsx` + `src/routes-web/` (固定深色 zinc/emerald，无 TG SDK). Shared code (`api/`, `providers/`, `hooks/`, `components/`, `paths.ts`, `constants.ts`) tree-shaken per entry.
- **Deployment (方案 A)**: single custom domain, Workers Routes split by path. `example.com/api/*`, `example.com/oauth/*`, `example.com/login*`, `example.com/mail/*`, `example.com/preview*`, `example.com/junk-check` → Worker; everything else → Pages. Same origin, zero CORS. Pages `_redirects` rewrites `/telegram-app/*` → `/miniapp.html`（其余 → `/index.html`），两套 bundle 物理隔离。`WORKER_URL` and BotFather `/setdomain` point at the root domain.

## Conventions

- **Layering**: `src/handlers/` only do routing / auth / req-resp shaping; business logic lives in `src/services/` or on a provider method.
- **Helpers**: if a helper is used by only ONE file, keep it file-private next to its caller. If used by MULTIPLE files, lift it to the nearest `utils/` dir — `src/utils/` for cross-cutting helpers, `src/bot/utils/` / `src/providers/<p>/utils.ts` for layer-scoped ones. Same goes for deduping: if you spot the same logic copy-pasted in two places (HMAC signing, OAuth refresh, etc.), extract it rather than keeping both.
- **Shared types**: shared interfaces / types go in `src/types.ts` (cross-cutting) or a colocated `types.ts` (module-scoped, e.g. `providers/types.ts`, `providers/outlook/types.ts`). Don't inline reusable types into handlers/services.
- **Error reporting**: use `reportErrorToObservability()`, not `console.error`.
- **Email providers**: abstract class in `src/providers/base.ts`, shared interfaces in `src/providers/types.ts`, barrel in `src/providers/index.ts` (exports `PROVIDERS`, `getEmailProvider`, `accountCanArchive`). Each concrete provider (`gmail/`, `outlook/`, `imap/`) has its own `index.ts` class + `utils.ts` + optional `types.ts`.
- **Provider polymorphism**: never branch on `account.type` outside `providers/`. Per-provider differences live on the class — static metadata (`displayName`, `oauth`, `canArchive`), instance methods (fetch / list / archive / push / `resolveMessageState` / `onPersistedChange`), and `static registerRoutes(app)` for webhooks (so adding a provider needs no handler wiring).
- **IMAP message ids = RFC 822 Message-Id** (not per-folder UID). The bridge API takes `rfcMessageId` and `SEARCH HEADER Message-Id`s to resolve the current UID. Emails without Message-Id are dropped. Gmail/Outlook keep native ids.
- **Archive**: `provider.archiveMessage(messageId)` + `accountCanArchive(account)`. Gmail requires the user to pick a label (stored in `accounts.archive_folder` + `accounts.archive_folder_name`); without it `canArchive()` returns false.
- **State reconciliation**: all "remote → TG" syncs funnel through `reconcileMessageState` (`services/message-actions.ts`), which uses `provider.resolveMessageState` and either removes the TG msg (non-inbox) or syncs star/pin (inbox).
- **Star pin**: ⭐ email ↔ pinned TG msg. Single entry point: `syncStarPinState` in `services/message-actions.ts`. A `pin-cleanup` handler deletes TG's "Bot pinned" service messages.
- **Disable/enable**: `accounts.disabled` pauses without deleting. Enforced in `services/bridge.ts::processEmailMessage` (queue consumer) + filtered in push renewal / mail-list / `/sync` / `getImapAccounts`.
- **Cron**: single `* * * * *` trigger. `handleScheduled` (`src/handlers/scheduled.ts`, parallel to `handlers/queue.ts`) dispatches due reminders every minute; `getUTCMinutes() === 0` gates the hourly batch (retry / IMAP bridge health); midnight additionally renews pushes.
- **Mail preview helpers** (CID inlining, image proxy rewriting, token signing) live in `src/services/mail-preview.ts`.
- **Mini App** (`web/src/routes-miniapp/telegram-app/`): 专属 bundle，`miniapp.html` 里加载 `telegram-web-app.js` SDK，样式走 `styles/miniapp.css`（HeroUI + TG 主题变量）。
  - `/telegram-app/` → `index.tsx` router entry, reads `window.Telegram.WebApp.initDataUnsafe.start_param` (`r_<chat>_<msg>` / `m_<chat>_<msg>`) and navigates.
  - `/telegram-app/reminders` → set/list/cancel reminders.
  - `/telegram-app/mail/$id` → email preview (fetches JSON from `GET /api/mini-app/mail/:id`, renders bodyHtml in sandbox iframe via `MailBodyFrame`, shows `MailFab` for star/archive/trash/junk/unarchive).
  - `/telegram-app/list/$type` → unread/starred/junk/archived lists.
- **Web 页面** (`web/src/routes-web/`): 独立 bundle，`index.html` 里不加载 TG SDK，样式走 `styles/web.css`（固定深色 zinc/emerald，`html { background: #09090b; color-scheme: dark }` 负责 iOS Safari safe area）。
  - `/mail/$id` → 浏览器里看邮件（HMAC token-only auth，不需要 initData）。
  - `/preview` → HTML → MarkdownV2 预览（session cookie）。
  - `/junk-check` → 垃圾邮件检测（session cookie）。
  - `/` → Landing 兜底页。
  - **Bot keyboard URLs** (`src/utils/mail-token.ts`, `src/bot/handlers/*`) still point at `/telegram-app/*` — intentional: those are the Mini App URLs registered in BotFather. Pages is configured to serve the SPA at those paths (or redirect from `/` → root). Private chat buttons are inline `web_app` pointing at subpage URLs; group chat uses `t.me/<bot>/<short>?startapp=<feature>_<chat>_<msg>` deep links which land on `/` router.
  - **Auth**: every API call goes through `web/src/lib/api.ts` (ky instance) which injects `X-Telegram-Init-Data`. Worker `requireMiniAppAuth` verifies. No cookies. Mail preview API also checks HMAC token.
  - **Types sharing**: `web/tsconfig.json` + `vite.config.ts` alias `@worker/*` → `../src/*`; web uses `import type` only. `web/src/lib/routes.ts` re-exports Worker's pure-string route constants so both sides stay in sync.
- **Email keyboard**: `buildEmailKeyboard` requires `tgMessageId`, so `deliverEmailToTelegram` sends the message naked, inserts `message_map`, then builds the keyboard and attaches it via `setReplyMarkup` — one code path for private + group. All other rebuild sites (refresh, toggle-star, reminder change, junk cancel) already have `tgMessageId`.
- **Reminders**: entry is exclusively through the ⏰ button on email messages (no `/remind` command). Auth on every API: `X-Telegram-Init-Data` via `utils/tg-init-data.ts::verifyTgInitData` + `users.approved`. Group deep-link resolve-context also checks `account.telegram_user_id === current user` (only the account owner can set reminders). Cron sends with `reply_parameters` so the reminder threads under the original email even if deleted.
  Setup: `WORKER_URL` env, BotFather `/setdomain`, `/newapp` to register the Mini App (so `?startapp=` works for group deep links).
