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

- **Handlers** (`src/handlers/`) only do routing and auth. Business logic belongs in `src/services/`.
- **Error reporting**: Use `reportErrorToObservability()` instead of `console.error`.
- **Email providers**: Abstract class pattern in `src/providers/`. The `EmailProvider` base class lives in `base.ts` and hosts cross-provider statics (`createOAuthHandler`, shared OAuth types). The `getEmailProvider` factory and re-exports live in `index.ts` (imported as `@providers`). Each concrete provider (`gmail/`, `outlook/`, `imap/`) owns its `index.ts` class and a `utils.ts` of provider-local helpers. Gmail and Outlook expose a `static oauth = EmailProvider.createOAuthHandler({...})` field for their OAuth flow — call sites use `GmailProvider.oauth.startOAuth(...)` etc.
- **Provider dispatch**: Never branch on `account.type` outside of `providers/`. Any per-provider difference belongs as an abstract method on `EmailProvider` (see `fetchRawEmail`, `listUnread`, `enqueue`, etc.). New operations: add abstract method to `base.ts`, implement in all three providers.
- **Mail preview helpers** (CID inlining, HTML proxy rewriting, preview URL tokens, CORS proxy signing) live in `src/services/mail-preview.ts`.
- **Cron triggers**: two schedules — `* * * * *` (every-minute reminder dispatch) and `0 * * * *` (hourly retry/health/digest/midnight push renew). `handleScheduled` in `src/index.ts` branches on `event.cron` to route work to the right handler.
- **Reminders**: per-email user reminders live in the `reminders` table; `src/services/reminders.ts:dispatchDueReminders` runs each minute, claims rows atomically (`UPDATE ... RETURNING` in `claimReminder`), and posts a Telegram message back-linking to the original email.
- **Archive**: `EmailProvider.archiveMessage` + `canArchive()`. Outlook moves to the `"archive"` well-known folder; IMAP moves to `account.archive_folder ?? "Archive"` via the bridge `/api/archive` endpoint; Gmail requires the user to pick a label (stored in `accounts.archive_folder`) — without it `canArchive()` returns false and the UI surfaces a hint.
