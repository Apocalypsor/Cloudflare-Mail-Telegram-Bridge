# Telemail — Agent Guide

> **Commit only when explicitly asked.** Don't auto-commit after finishing a task — wait for the user to say so.
> **Before commit**: `bun check` (Biome) + `bun typecheck` (tsc) from repo root. Don't use `biome-ignore`. Update `README.md` / `docs/*` when you change behavior they describe.

User-facing docs: `README.md`, `docs/DEVELOPMENT.md`, `docs/DEPLOYMENT.md`, `docs/ENVIRONMENT.md`.

Per-workspace guides: [`worker/AGENTS.md`](./worker/AGENTS.md) · [`page/AGENTS.md`](./page/AGENTS.md) · [`middleware/AGENTS.md`](./middleware/AGENTS.md).

Cloudflare API knowledge may be stale — fetch <https://developers.cloudflare.com/workers/> before any Workers/KV/D1/Queues task.

## Workspaces (bun monorepo)

- **`worker/`** Cloudflare Worker (Elysia + grammY) — bot webhook, queue, cron, providers, D1. Owns `wrangler.example.jsonc` + `migrations/`. CI generates real `wrangler.jsonc` via `envsubst` from `CF_D1_DATABASE_ID` + `CF_KV_NAMESPACE_ID`.
- **`page/`** Cloudflare Pages SPA (Vite + React + TanStack Router/Query + HeroUI + Eden treaty) — single bundle serves both web pages and Mini App routes (`/telegram-app/*`).
- **`middleware/`** IMAP bridge (Bun + Elysia + ImapFlow) — **not on Cloudflare**. Built to single binary, packaged as multi-arch docker image. User runs it on their server; Worker calls it via `IMAP_BRIDGE_URL` + `IMAP_BRIDGE_SECRET`.

Single custom domain. `*.com/api/*` + `/oauth/*` → Worker; everything else → Pages. Same origin, zero CORS.

CI/CD via `.github/workflows/ci.yml` — `dorny/paths-filter` decides which deploy jobs run. Required secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

All scripts run from repo root. Read root + per-workspace `package.json` for the actual command list.

## Cross-cutting conventions

- **Helpers**: file-private if used in ONE file; lift to nearest `utils/` (or `components/` / `hooks/` on page side) when used in multiple. Same applies to dedup — extract instead of copy-pasting.
- **Shared types**: `worker/types.ts` for cross-cutting; module-scoped `types.ts` (e.g. `providers/types.ts`) otherwise. Never inline reusable types into handlers / services / route components.
- **Error reporting** (worker): `reportErrorToObservability(env, "tag", err)`, never `console.error`. Page side: surface via `extractErrorMessage()`, no silent swallowing.
- **Cross-package imports**: only three TS path aliases exist repo-wide — `@page/*` `@worker/*` `@middleware/*`, declared in `tsconfig.base.json`. Page imports `@worker/*` are **type-only** (no runtime — keeps the page bundle slim). Worker imports `@page/paths` (Mini App URL constants) and `@middleware/index` (Eden `App` type for the IMAP bridge client).
- **Auth + API contract**: page calls worker through Eden treaty (`page/src/api/client.ts` exports `treaty<App>(...)` where `App` comes from `import type { App } from "@worker/api"`). Eden auto-injects `X-Telegram-Init-Data` in TG context; worker plugin `authMiniApp` verifies. Web pages use a session cookie (`authSession`). Mail preview GET also accepts an HMAC token. Worker calls middleware the same way (`treaty<App>` against `@middleware/index`, with `throwHttpError: true`).
