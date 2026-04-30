# Worker — Agent Guide

Cloudflare Worker (Elysia + grammY). Cross-workspace rules in [root AGENTS.md](../AGENTS.md).

## Layout (`src/`)

- **`api/`** — HTTP layer (Elysia). `api/modules/<feature>/{index.ts(x), model.ts, [utils.ts], [components.tsx]}` per Elysia best-practice (1 instance = 1 controller, models in `t.Object(...)`). `api/plugins/` holds shared `cf` (env + waitUntil derive), `auth-{session,miniapp,any}`, `secrets` plugins. `api/index.ts` composes everything with `CloudflareAdapter` + `.compile()` and exports `type App` for Eden.
- **`bot/`** — Telegram bot (grammY). Self-contained: `handlers/<feature>/`, `utils/` (formatters, state, account cleanup, etc.), `commands.ts`, `keyboards.ts`. **No** sub-`services/` — bot-internal helpers all live in `bot/utils/`.
- **`handlers/`** — non-HTTP entry points: `queue/{index.ts, bridge.ts}` (queue consumer + email delivery), `scheduled/{index.ts, reminders.ts}` (cron + reminder dispatch).
- **`clients/`** — outbound HTTP layer: shared `ky` instance (`http.ts`) + hand-written external API wrappers (`telegram.ts`, `llm.ts`).
- **`providers/`** — email provider impls (Gmail / Outlook / IMAP), abstract in `base.ts`, barrel in `index.ts`. Per-provider differences stay on the class — **never `branch on account.type` outside `providers/`**.
- **`db/`** — D1 + KV access. Schema-typed wrappers only.
- **`utils/`** — cross-cutting helpers: pure (`markdown-v2`, `format`, `hash`, `mail-token`), thin wrappers over external libs (`observability` over `workers-observability-hub`), AND cross-feature domain ops (`message-actions/`, `mail-list.ts`) used by both `bot/` and `api/`.
- **`i18n/`** — translations.

Decision tree for a new file: HTTP route → `api/modules/<feature>/`; bot command → `bot/handlers/`; new email provider → `providers/`; SQL/KV → `db/`; outbound API SDK → `clients/`; cross-cutting helper → `utils/`. Anything else used by only one consumer goes file-private next to the consumer.

## Conventions

- **Aliases**: only three TS path aliases exist repo-wide — `@page/*` `@worker/*` `@middleware/*`, declared in root `tsconfig.base.json`. Worker-internal imports use `@worker/db/...` `@worker/bot/...` `@worker/utils/...` etc.; cross-package middleware access goes through `@middleware/index` (Eden treaty `App` type) and `@page/paths` (Mini App URL constants).
- **HTTP**: every generic outbound request goes through `@worker/clients/http` (a `ky` instance). No raw `fetch`. Centralized retry / parse-fallback lives there. **IMAP middleware** is the exception — talk to it through the Eden treaty client at `@worker/providers/imap/utils` (see below).
- **IMAP bridge client**: `bridgeClient(env)` in `@worker/providers/imap/utils.ts` returns `treaty<MiddlewareApp>(..., { throwHttpError: true })` typed against `import type { App } from "@middleware/index"`. Path / body / response auto-derive from the middleware Elysia app — adding or changing a route there immediately surfaces here as a TS error. Eden auto-throws `EdenFetchError` on non-2xx; `bridgeCall(...)` (same file) just wraps `await` and narrows TS's `T | null` data to `T`. `reportErrorToObservability` formats the resulting error message. Never construct middleware URLs by hand.
- **Env / waitUntil**: in Elysia handlers, destructure `{ env, executionCtx, waitUntil }` from context (provided by `cf` plugin). Outside HTTP context, `import { env } from "cloudflare:workers"`. Don't pass `env: Env` through new function signatures unless interfacing with framework-agnostic services.
- **Bot commands**: private chat only by default — `bot/index.ts` registers `registerPrivateOnlyCommandGuard` as a global guard (also covers `channel_post`). New commands don't need to re-check; `callback_query` is unaffected.
- **State reconciliation**: all "remote → TG" syncs go through `reconcileMessageState` (`utils/message-actions/reconcile.ts`). Star pin goes through `syncStarPinState`. **Don't** patch state in multiple places.
- **Disable/enable**: `accounts.disabled` pauses an account without deleting data. Enforcement points: `handlers/queue/bridge.ts::processEmailMessage`, push renewal, mail-list, `/sync`, `getImapAccounts`.
- **IMAP message id = RFC 822 Message-Id** (not the per-folder UID). The bridge takes `rfcMessageId` everywhere; UIDs aren't stable across folders. Emails without Message-Id are dropped. Gmail / Outlook keep their native ids.
- **Archive**: `provider.archiveMessage(id)` + `accountCanArchive(account)`. Gmail needs the user to pick a label (`accounts.archive_folder`); without one `canArchive()` returns false.
- **Cron**: single `* * * * *` trigger. Reminders dispatch every minute; `getUTCMinutes() === 0` gates the hourly batch; midnight renews all push subscriptions.
- **Email keyboard**: `buildEmailKeyboard` requires `tgMessageId`, so the delivery flow is send naked → insert message_map → build keyboard → `setReplyMarkup`. **One code path** covers both private chat and groups.
- **Reminders**: the only entry is the ⏰ button on email messages. Auth: `X-Telegram-Init-Data` + `users.approved`; group deep-link also verifies `account.telegram_user_id === current user`. Cron sends with `reply_parameters` so reminders thread under the original email.
