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
