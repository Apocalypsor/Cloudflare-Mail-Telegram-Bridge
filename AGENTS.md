# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command              | Purpose                                        |
| -------------------- | ---------------------------------------------- |
| `npm run dev`        | Build CSS + local development                  |
| `npm run deploy`     | Build CSS + deploy to Cloudflare               |
| `npm run build:css`  | Generate Tailwind CSS (src/assets/tailwind.ts) |
| `npm test`           | Run tests (vitest)                             |
| `npm run cf-typegen` | Generate TypeScript types from wrangler.jsonc  |

**IMPORTANT**: Prettier + tsc run automatically on pre-commit hook (husky + lint-staged). You can also run `npx prettier --write <file>` manually.
Run `npm run cf-typegen` after changing bindings in wrangler.jsonc.
Run `npm run build:css` after changing Tailwind classes in components (auto-runs with dev/deploy).

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Architecture Overview

Telemail is a Cloudflare Worker that forwards emails (Gmail / Outlook / IMAP) to Telegram.

**Entry point**: `src/index.ts` — exports `fetch` (Hono app), `queue` (email processing), `scheduled` (cron).

**Key bindings** (defined in `wrangler.jsonc`):

- **D1** (`DB`): accounts, users, message_map, failed_emails tables
- **KV** (`EMAIL_KV`): access_token cache, dedup, OAuth state, mail HTML cache, bot info
- **Queue** (`EMAIL_QUEUE`): email processing with retry (max 3, batch 5, concurrency 3)
- **Service Binding** (`OBS_SERVICE`): observability error reporting
- **Cron** (`0 * * * *`): hourly IMAP health check; midnight-only Gmail watch + Outlook subscription renewal

**Auth middleware** (`src/handlers/hono/middleware.ts`):

- `requireSecret('GMAIL_PUSH_SECRET')` — query param secret for Pub/Sub push
- `requireBearer('IMAP_BRIDGE_SECRET')` — Authorization header for IMAP bridge
- `requireTelegramLogin()` — Telegram Login Widget session cookie (protects preview pages)

**Email provider abstraction**: `src/services/email/provider.ts` — unified interface dispatching across Gmail, Outlook, and IMAP: `markAsRead`, `addStar`, `removeStar`, `isStarred`, `isJunk`, `markAsJunk`, `moveToInbox`, `trashMessage`, `trashAllJunk`, `listUnread`, `listStarred`, `listJunk`.

## Constants

All shared constants live in `src/constants.ts`. This includes:

- **API URLs**: `GMAIL_API`, `MS_GRAPH_API`, `TG_API_BASE`, OAuth token/authorize URLs
- **KV key prefixes**: `KV_OAUTH_STATE_PREFIX`, `KV_OAUTH_BOT_MSG_PREFIX`, `KV_MS_SUB_ACCOUNT_PREFIX`, `KV_MS_SUBSCRIPTION_PREFIX`, `KV_BOT_INFO_KEY`, `KV_BOT_COMMANDS_VERSION_KEY`
- **TTLs**: `MAIL_HTML_CACHE_TTL`, `OAUTH_STATE_TTL_SECONDS`, `BOT_INFO_TTL`
- **Telegram limits**: `TG_MSG_LIMIT`, `TG_CAPTION_LIMIT`, `TG_MEDIA_GROUP_LIMIT`, `TG_MAX_RETRY_AFTER_SECS`
- **LLM / mail processing**: `MAX_BODY_CHARS`, `MAX_LINKS`
- **IMAP flags**: `IMAP_FLAG_SEEN`, `IMAP_FLAG_FLAGGED`
- **Display settings**: `MESSAGE_DATE_LOCALE`, `MESSAGE_DATE_TIMEZONE`

When adding new KV keys used across multiple files, add a `KV_` prefixed constant here rather than hardcoding strings.

## Path Aliases

TypeScript path aliases are configured in `tsconfig.json` and resolved by Wrangler at build time. Use aliases instead of relative paths in all imports:

| Alias           | Resolves to        |
| --------------- | ------------------ |
| `@/*`           | `src/*`            |
| `@utils/*`      | `src/utils/*`      |
| `@services/*`   | `src/services/*`   |
| `@bot/*`        | `src/bot/*`        |
| `@db/*`         | `src/db/*`         |
| `@handlers/*`   | `src/handlers/*`   |
| `@components/*` | `src/components/*` |
| `@assets/*`     | `src/assets/*`     |

Examples: `import { Env } from '@/types'`, `import { analyzeEmail } from '@services/llm'`, `import { reportErrorToObservability } from '@utils/observability'`.

## Theme

All color values are centralized in `src/assets/theme.ts` (slate/blue palette). Used by the mail preview FAB and any inline CSS injected outside of Tailwind context.

## LLM Analysis

`analyzeEmail()` in `src/services/llm.ts` performs a single LLM call (with 30s timeout) returning:

- `verificationCode`: extracted OTP/passcode, or `null`
- `summary`: bullet-point summary (skipped when a verification code is found)
- `tags`: 1–3 single-word tags, first letter capitalized, same language as the email (e.g. `Github`, `Verification`, `Password_Reset`)
- `isJunk` / `junkConfidence`: spam classification. Emails with confidence ≥ 0.8 are auto-moved to junk folder, TG message deleted.

## Bot Commands

Bot commands are defined in `src/bot/index.ts` (`BOT_COMMANDS` array) and auto-synced to Telegram via `setMyCommands` on each webhook request (gated by KV-stored `BOT_COMMANDS_VERSION` — only calls the API when the version changes). Increment `BOT_COMMANDS_VERSION` after modifying the command list; deploy and send any message to the Bot to trigger sync.

## Error Reporting

Use `reportErrorToObservability()` from `src/utils/observability.ts` instead of `console.error` / `console.warn` for all error handling. The observability service forwards errors to the monitoring system; `console.error` output may not be visible in production. The only exceptions are inside `observability.ts` itself and in utility functions that don't have access to `env` (e.g., `telegram.ts`).

## Documentation Maintenance

After making significant changes (new features, architectural refactors, route changes, dependency changes), update:

1. **AGENTS.md** — Keep commands, conventions, and project-specific notes current.
2. **README.md** — Update project description, setup instructions, route documentation, and tech stack as needed.
