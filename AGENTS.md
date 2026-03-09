# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command               | Purpose                                          |
| --------------------- | ------------------------------------------------ |
| `npm run dev`         | Build CSS + local development                    |
| `npm run deploy`      | Build CSS + deploy to Cloudflare                 |
| `npm run build:css`   | Generate Tailwind CSS (src/assets/tailwind.ts)   |
| `npm test`            | Run tests (vitest)                               |
| `npx wrangler types`  | Generate TypeScript types from wrangler.jsonc    |

Run `wrangler types` after changing bindings in wrangler.jsonc.
Run `npm run build:css` after changing Tailwind classes in components (auto-runs with dev/deploy).

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Documentation Maintenance

After making significant changes (new features, architectural refactors, route changes, dependency changes), update:

1. **AGENTS.md** — Keep commands, conventions, and project-specific notes current.
2. **README.md** — Update project description, setup instructions, route documentation, and tech stack as needed. Create it if it doesn't exist.
