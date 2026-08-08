# Worker — Agent Guide

Follow the parent guide first. This file adds only durable Worker-side expectations; it is not a source map.

## Explore First

Before changing Worker behavior, inspect the current entrypoints, runtime config, bindings, handlers, provider abstractions, persistence wrappers, and user-facing docs relevant to the task. Do not rely on this file for source structure, route inventory, provider inventory, binding names, secret names, cron cadence, or deployment topology.

## Elysia Pattern

This is a fixed code organization rule for Elysia code, not an inventory of current routes.

[Elysia "Service"](https://elysiajs.com/essential/best-practice.html#service) means two different patterns here:

- **Non-request-dependent** - does not read cookies, headers, or Elysia `Context`; dependencies are passed explicitly, such as `env`. Use `abstract class XxxService { static foo(env, ...) {} }` in the feature module's `service.ts`.
- **Request-dependent** - reads cookies, headers, or Elysia `Context` for auth, env injection, and similar concerns. This should be an Elysia instance under `plugins/<name>/` or an equivalent plugin file. The plugin itself is the service; do not add a separate `service.ts` inside a plugin directory.

Module directories use only these file roles:

```
index.ts        # Elysia controller - routes + handlers
model.ts        # request / response schema
types.ts        # unions / interfaces that do not fit in schema
service.ts      # business orchestration across DB / provider / KV / HMAC
utils.ts        # pure helpers - single-purpose, no business context dependency
components.ts   # SSR HTML when needed
```

How to decide service vs utils: needs runtime env plus multiple DB / provider calls -> service; formatter / parser / one-line lookup -> util.

When `utils.ts` grows too large, promote it to a `utils/` directory with purpose-named files. Do not use generic child filenames like `service.ts`, `lib.ts`, or `helpers.ts`; `service.ts` is only allowed at the module root.

## Conventions

- **Use current boundaries**: find the existing owner for a behavior before adding code. Preserve established provider, API, bot, persistence, and utility boundaries unless the change is intentionally restructuring them.
- **Provider behavior**: start from the current provider abstraction and dispatch pattern before changing mail sync, message actions, archive, forwarding, or OAuth behavior. Do not duplicate provider-specific branching in unrelated layers.
- **Runtime context**: follow the current handler pattern for passing runtime environment, background work, and side effects. Do not introduce hidden globals for request/runtime state.
- **Error reporting**: use the existing Worker error-reporting path instead of ad hoc logging.
- **Persistence**: use existing typed database / KV wrappers. Do not hand-write storage access in feature code when a local wrapper pattern already exists.
- **User-visible behavior**: update user-facing docs when changing account setup, delivery behavior, auth, reminders, or deployment requirements.
