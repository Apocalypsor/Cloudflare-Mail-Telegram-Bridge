# Cloudflare Workers

> **MANDATORY: Code Quality & Documentation**
>
> Before committing ANY changes, you MUST:
>
> 1. Run `pnpm check` — Biome lint + format check. Fix ALL errors and warnings. Do NOT use `biome-ignore` — fix the code instead.
> 2. Run `pnpm typecheck` — TypeScript type checking. Fix ALL errors.
> 3. Update **AGENTS.md** and **README.md** if your changes affect commands, conventions, architecture, or features. Do not forget README.md.
>
> These checks also run automatically on pre-commit hook (husky + lint-staged).

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command           | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `pnpm dev`        | Build CSS + local development                  |
| `pnpm deploy`     | Build CSS + deploy to Cloudflare               |
| `pnpm build:css`  | Generate Tailwind CSS (src/assets/tailwind.ts) |
| `pnpm check`      | Lint + format check (Biome)                    |
| `pnpm typecheck`  | TypeScript type checking (tsc --noEmit)        |
| `pnpm cf-typegen` | Generate TypeScript types from wrangler.jsonc  |

**IMPORTANT**: Biome check runs automatically on pre-commit hook (husky + lint-staged). You can also run `pnpm check --fix` or `pnpm exec biome check --write <file>` manually.
Run `pnpm cf-typegen` after changing bindings in wrangler.jsonc.
Run `pnpm build:css` after changing Tailwind classes in components (auto-runs with dev/deploy).

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Email Provider Architecture

Email operations use an abstract class pattern in `src/services/email/`:

- **`provider.ts`** — `EmailProvider` abstract base class + `getEmailProvider()` factory + `renewAllPush()`
- **`gmail/`**, **`outlook/`**, **`imap/`** — each follows the same structure:
  - `index.ts` — concrete Provider class (extends `EmailProvider`) + re-exports from utils
  - `utils.ts` — low-level helpers (OAuth, REST clients, bridge calls)
  - `oauth.ts` — OAuth flow (Gmail/Outlook only)

All email operations (message actions, push management, notification enqueue) are methods on the Provider class. Handlers only do auth + call `Provider.method()`.

When adding new email operations:
1. Add abstract method to `EmailProvider` in `provider.ts`
2. Implement in all three provider classes (`GmailProvider`, `OutlookProvider`, `ImapProvider`)
3. Low-level HTTP helpers go in the provider's `utils.ts`, NOT in `index.ts`

## Conventions

- **Handlers** (`src/handlers/`) only do routing and auth. Business logic belongs in `src/services/`.
- **Error reporting**: Use `reportErrorToObservability()` from `src/utils/observability.ts` instead of `console.error`.
- **Theme**: Color values in `src/assets/theme.ts`.

## Documentation Maintenance

After making significant changes (new features, architectural refactors, route changes, dependency changes), update:

1. **AGENTS.md** — Keep commands, conventions, and project-specific notes current.
2. **README.md** — Update project description, setup instructions, route documentation, and tech stack as needed. **Do not forget to update README.md** — it is the user-facing documentation and must stay in sync with AGENTS.md.
