# Telemail — Agent Guide

> **Commit only when explicitly asked.** Don't auto-commit after finishing a task — wait for the user to say so.
> **Before commit**: `bun check` (Biome) + `bun typecheck` (tsc) from repo root. Don't use `biome-ignore`. Update user-facing docs when you change behavior they describe.
> **Commit message convention**: use Conventional Commits (`<type>(optional-scope): <summary>`). Feature work must start with `feat:` (for example, `feat: add account sync`); use `fix:`, `docs:`, `chore:`, etc. only when that type accurately describes the change.

## Explore first

Treat this guide as stable guardrails, not a live architecture inventory. Before changing a workspace, inspect the current source, package scripts, runtime config, deploy config, migrations if relevant, and user-facing docs when the behavior is user-facing. Use `rg` to find existing patterns and call sites before adding new ones.

If this guide conflicts with checked-in code or docs, trust the checked-in code after verifying the behavior, then update the guide only for durable conventions. Do not encode architecture inventories, fixed source structure, deployment topology, secret names, route inventories, cadence values, or one-off file locations here when a future agent can discover them directly from source.

Cloudflare API knowledge may be stale — fetch <https://developers.cloudflare.com/workers/> before any Workers/KV/D1/Queues task.

Routing, domains, deploy conditions, runtime topology, workspace structure, and required secrets belong to the checked-in source, config, and documentation. Verify those files instead of assuming them from this guide.

Read the current package scripts before running commands.

Commands that access the network (including package-registry queries, `npm pack`, and documentation downloads) need explicit network permission in restricted sandboxes. Request the required escalation as soon as network access is needed; if a sandboxed command fails with a network, DNS, or registry error, immediately rerun it with escalation instead of waiting or retrying silently.

## Repo Conventions

- **Helpers**: file-private if used in one file; place those file-private helpers at the bottom of the file, after the main exported component/function, when execution order allows. Keep setup constants and framework-required declarations in their natural positions. Lift to the nearest established shared location when used in multiple places. Same applies to dedup — extract instead of copy-pasting.
- **No barrel imports**: do not add modules that only re-export from other modules. Public entrypoint files that contain real logic are fine; re-export-only barrels are banned.
- **Function style**: use arrow function expressions for standalone functions (`const foo = (...) => {}` / `export const foo = (...) => {}`), including helpers, React components, hooks, route-local handlers, and nested functions. Keep class methods, object literal methods, framework route chaining, and type / interface method signatures in their idiomatic syntax.
- **Type placement**: in regular implementation files, keep module-level `interface` and `type` declarations immediately after imports, before runtime constants, functions, classes, components, and hooks. Schema-derived aliases may stay next to the value they derive from. Do not park local interfaces at the bottom of a file.
- **Cross-package imports**: use only the path aliases declared by the current TypeScript config. Browser-side imports from backend packages must stay type-only unless the current bundler config explicitly supports the runtime import. Do not add short aliases that hide package ownership.
- **Auth + API contract**: do not hand-write HTTP contracts. Start from the current clients, exported app types, and auth plugins before changing route/method/body/query/response shapes.
