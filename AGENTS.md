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
- **Cron triggers**: one schedule — `0 * * * *` (hourly retry/health/digest; midnight additionally renews pushes). `handleScheduled` in `src/index.ts` routes per-hour tasks; `isMidnight` + `isDigestHour` gate the time-specific ones.
- **Archive**: instance method `archiveMessage(messageId)` + static `canArchive(account)` (accessed via `accountCanArchive(account)`). Outlook moves to the `"archive"` well-known folder; IMAP goes through the bridge `/api/archive` endpoint, which resolves the target folder as `account.archive_folder` → `\Archive` special-use → literal `"Archive"` (auto-created if missing); Gmail requires the user to pick a label (stored in `accounts.archive_folder` as the label ID, plus `accounts.archive_folder_name` for human-readable display) — without it `canArchive()` returns false and the UI surfaces a hint.
- **State reconciliation**: `provider.resolveMessageState(messageId, rfcMessageId?)` returns `{ location: "inbox" | "junk" | "archive" | "deleted", starred? }`. All "sync remote → TG" entry points (refresh button, initial delivery) funnel through `reconcileMessageState` in `services/message-actions.ts`, which deletes the TG msg + mapping for non-inbox locations and syncs star/pin for inbox. Gmail does it in one API call (labelIds); Outlook in five parallel Graph calls; IMAP needs the RFC Message-Id (stored as `message_map.rfc_message_id` at delivery) and calls bridge `/api/locate` for cross-folder search — UIDs are per-folder so they can't locate a moved message.
- **Star pin**: ⭐ email = pin TG msg. `syncStarPinState` in `services/message-actions.ts` is the single entry point; `deliverEmailToTelegram` + `toggleStar` + preview toggle-star + starred-list refresh all call it. Bot has a `pin-cleanup` handler that auto-deletes TG's "Bot pinned this message" service messages.
- **Disable/enable**: `accounts.disabled` (INTEGER 0/1) pauses an account without deleting it. Queue consumer (`services/bridge.ts::processEmailMessage`) drops messages for disabled accounts — a single enforcement point covering all three providers' push paths. Other non-queue paths filter explicitly: `renewAllPush`, `sendDigestNotifications`, mail-list handlers, `/sync`, and `getImapAccounts` (SQL `WHERE disabled = 0`, so the bridge stops polling on next reconcile). Toggling an IMAP account also POSTs `/api/sync` to the bridge for immediate effect.
