# Cloudflare Workers

> Before committing, run `pnpm check` (Biome) and `pnpm typecheck` (tsc). Fix ALL errors. Do NOT use `biome-ignore`. Update AGENTS.md and README.md if needed.

Your knowledge of Cloudflare Workers APIs may be outdated. Retrieve current docs before any Workers/KV/D1/Queues task: <https://developers.cloudflare.com/workers/>

## Commands

| Command           | Purpose                                       |
| ----------------- | --------------------------------------------- |
| `pnpm dev`        | Build CSS + local development                 |
| `pnpm deploy`     | Build CSS + deploy to Cloudflare              |
| `pnpm check`      | Lint + format check (Biome)                   |
| `pnpm typecheck`  | TypeScript type checking (tsc --noEmit)       |
| `pnpm cf-typegen` | Generate TypeScript types from wrangler.jsonc |
| `pnpm build:css`  | Generate Tailwind CSS (src/assets/tailwind.ts)|

Run `pnpm cf-typegen` after changing bindings in wrangler.jsonc.

## Conventions

- **Handlers** (`src/handlers/`) only do routing, auth, and request/response shaping. Business logic belongs in `src/services/` or on a provider method.
- **Error reporting**: Use `reportErrorToObservability()` instead of `console.error`.
- **Email providers**: Abstract class pattern in `src/providers/`. `base.ts` hosts the `EmailProvider` abstract class + `createOAuthHandler` factory; `types.ts` holds all provider-level interfaces (`EmailListItem`, `PreviewContent`, `OAuthHandler`, `EmailProviderClass`, etc.). `index.ts` is the barrel: it exports `PROVIDERS` (AccountType → class map), `getEmailProvider(account, env)` factory, and `accountCanArchive(account)` helper. Each concrete provider (`gmail/`, `outlook/`, `imap/`) owns its `index.ts` class, a `utils.ts` of API helpers, and optionally a `types.ts` for API response shapes.
- **Provider polymorphism**: Never branch on `account.type` outside of `providers/`. Per-provider differences live on the class:
  - **Static metadata**: `displayName`, `needsArchiveSetup`, `oauth?` (with `name` + `isConfigured(env)`), `canArchive(account)`
  - **Instance methods** (on `EmailProvider` base): `fetchRawEmail`, `fetchForPreview` (base default = raw + PostalMime; Gmail override uses API), `listUnread/Starred/Junk/Archived`, `markAsJunk`, `archiveMessage`, `moveToInbox`, `trashMessage`, `trashAllJunk`, `renewPush`, `stopPush`, `onPersistedChange` (IMAP notifies bridge; others no-op)
  - **Static HTTP routes**: each provider with a webhook / bridge endpoint implements `static registerRoutes(app)` — `handlers/hono/push.ts` just loops `PROVIDERS` and calls each. Adding a provider → no handler file wiring needed. Route path constants (`/api/gmail/push` etc.) live as `private static readonly` inside the provider class.
- **Mail preview helpers** (CID inlining, HTML proxy rewriting, preview URL tokens, CORS proxy signing) live in `src/services/mail-preview.ts`.
- **Cron triggers**: one schedule — `* * * * *` (per-minute). `handleScheduled` in `src/index.ts` always dispatches due reminders; `getUTCMinutes() === 0` gates the hourly batch (retry/health/digest); midnight additionally renews pushes.
- **Archive**: instance method `archiveMessage(messageId)` + static `canArchive(account)` (accessed via `accountCanArchive(account)`). Outlook moves to the `"archive"` well-known folder; IMAP goes through the bridge `/api/archive` endpoint, which resolves the target folder as `account.archive_folder` → `\Archive` special-use → literal `"Archive"` (auto-created if missing); Gmail requires the user to pick a label (stored in `accounts.archive_folder` as the label ID, plus `accounts.archive_folder_name` for human-readable display) — without it `canArchive()` returns false and the UI surfaces a hint.
- **State reconciliation**: `provider.resolveMessageState(messageId, rfcMessageId?)` returns `{ location: "inbox" | "junk" | "archive" | "deleted", starred? }`. All "sync remote → TG" entry points (refresh button, initial delivery) funnel through `reconcileMessageState` in `services/message-actions.ts`, which deletes the TG msg + mapping for non-inbox locations and syncs star/pin for inbox. Gmail does it in one API call (labelIds); Outlook in five parallel Graph calls; IMAP needs the RFC Message-Id (stored as `message_map.rfc_message_id` at delivery) and calls bridge `/api/locate` for cross-folder search — UIDs are per-folder so they can't locate a moved message.
- **Star pin**: ⭐ email = pin TG msg. `syncStarPinState` in `services/message-actions.ts` is the single entry point; `deliverEmailToTelegram` + `toggleStar` + preview toggle-star + starred-list refresh all call it. Bot has a `pin-cleanup` handler that auto-deletes TG's "Bot pinned this message" service messages.
- **Disable/enable**: `accounts.disabled` (INTEGER 0/1) pauses an account without deleting it. Queue consumer (`services/bridge.ts::processEmailMessage`) drops messages for disabled accounts — a single enforcement point covering all three providers' push paths. Other non-queue paths filter explicitly: `renewAllPush`, `sendDigestNotifications`, mail-list handlers, `/sync`, and `getImapAccounts` (SQL `WHERE disabled = 0`, so the bridge stops polling on next reconcile). Toggling an IMAP account also POSTs `/api/sync` to the bridge for immediate effect.
- **Mini App layout** (`src/components/miniapp/`): three pages on the same TG domain (so navigation stays in-app):
  - `/telegram-app` → `MiniAppRouterPage` (router): the BotFather-registered URL. Reads `Telegram.WebApp.initDataUnsafe.start_param` (`r_<chat>_<msg>` / `m_<chat>_<msg>` / no-prefix legacy), calls `/api/reminders/resolve-context` to get `(accountId, messageId, token)`, then `location.replace`s to the right subpage.
  - `/telegram-app/reminders` → `RemindersPage`: set / list / cancel reminders. Email card click → navigates to mail page.
  - `/telegram-app/mail/:id` → `MiniAppMailPage`: same fetch logic as web `/mail/:id` but TG-themed shell + `telegram-web-app.js`. Same FAB action endpoints (`/api/mail/:id/...`, token auth).
  Private chat web_app inline buttons jump straight to subpage URLs (skip router); group chat inline buttons can't be `web_app` (BUTTON_TYPE_INVALID), so they're `url` deep links to `t.me/<bot>/<short_name>?startapp=<feature>_<chat>_<msg>` which lands on router.
- **Reminders (email-bound Mini App)**: every email TG message has a ⏰ button on its inline keyboard (`buildEmailKeyboard` in `src/bot/keyboards.ts`). Two button modes by chat type:
  - **Private chat**: `web_app` inline button → opens `/reminders?accountId=&messageId=&token=` directly in TG WebView (token is the same `generateMailTokenById` HMAC the mail-preview link uses).
  - **Group/channel** (TG forbids `web_app` inline buttons → 400 BUTTON_TYPE_INVALID): `url` button to `https://t.me/<bot>?startapp=<chatId>_<tgMsgId>` deep link; sends user to private chat with bot, opens Mini App with `Telegram.WebApp.initDataUnsafe.start_param`. Mini App calls `GET /api/reminders/resolve-context?start=…` which looks up `message_map` by the (chatId, tgMsgId) composite key, checks `account.telegram_user_id === current user` (only account owner can set reminders, prevents group members from spamming the owner), and returns the (accountId, messageId, token) triple. **Group keyboard requires `tgMessageId`** which doesn't exist when `bridge.ts` first builds the keyboard before send — so initial group delivery has no ⏰ button; it gets added by the LLM-analysis edit (which already rebuilds the keyboard with `sentMessageId` known) or any subsequent keyboard rebuild (refresh/star toggle/junk cancel). Bot username is read from cached bot info in KV (`getCachedBotInfo`).
  Server (`src/handlers/hono/reminders.tsx`): on POST, re-verifies token, looks up `message_map` for `tg_chat_id`/`tg_message_id`, snapshots `email_subject` from KV cache, writes a `reminders` row. Auth on every API: `X-Telegram-Init-Data` header validated by `src/utils/tg-init-data.ts::verifyTgInitData` (HMAC per Telegram WebApp spec) + `users.approved` check. Per-minute cron calls `dispatchDueReminders` (`src/services/reminders.ts`); for email reminders sends to `tg_chat_id` (the chat where the email landed) with `reply_parameters: { message_id: tg_message_id, allow_sending_without_reply: true }` so the reminder threads under the original even if it was deleted. Permanent send errors (bot blocked/kicked) → mark `sent_at` to stop retrying; transient errors → leave pending.
  Setup: `WORKER_URL` env var required, `/setdomain` set to that domain in BotFather, and `/newapp` to register a Mini App so `?startapp=` works for group deep links.
  Limitation: no generic `/remind` command — entry is exclusively via email message buttons.
