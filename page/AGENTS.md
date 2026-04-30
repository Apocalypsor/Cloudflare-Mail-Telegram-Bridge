# Page — Agent Guide

Cloudflare Pages SPA (Vite + React 19 + TanStack Router/Query + HeroUI + ky + zod). A single entry serves both browser web pages and Mini App routes (`/telegram-app/*`). Cross-workspace rules in [root AGENTS.md](../AGENTS.md).

## Conventions

- **Route folder pattern**: each route is a directory `routes/<route>/index.tsx`; route-private code lives in sibling `-components/` / `-utils/`. TSR's `tanstackRouter({ autoCodeSplitting: true })` skips `-`-prefixed dirs (not treated as route segments). Dynamic params work too: `routes/mail/$id/index.tsx` ↔ `/mail/$id`.
- **Keep `index.tsx` thin**: state, data fetching (useQuery/useMutation), navigate behavior, composing presentational components from `-components/`. **Don't** define large components inside the route file.
- **Helpers / shared bits**: route-only → `routes/<route>/-components/` or `-utils/`; used by 2+ routes → `page/src/components/` / `hooks/` / `utils/`; style constants go in `styles/`. Grep before writing new code so you don't recreate something.
- **Aliases**: `@/*` → `page/src/*`; specific shortcuts `@api/*` `@components/*` `@hooks/*` `@providers/*` `@routes/*` `@styles/*` `@utils/*` (prefer these over `@/...` for new code); `@worker/*` → `../worker/*` (**only import types / string constants**, no runtime). Defined in `page/tsconfig.json`; Vite picks them up via `vite-tsconfig-paths` (no duplicate alias config in `vite.config.ts`).
- **Route validation**: use a zod search schema (`zodValidator(searchSchema)`); fall back optional params with `fallback(...)` so a dirty URL doesn't crash the whole page in `errorComponent`.
- **TG Mini App vs Web**:
  - Mini App (`/telegram-app/*`): uses `@telegram-apps/sdk-react`. Init / mount / theme colors / fullscreen happen in `providers/telegram.tsx`. Helpers in `@utils/tg` (`notifyHaptic`, `confirmPopup`, `alertPopup`, `openExternalLink`, `openTgLink`, `closeMiniAppSafe`); buttons go through hooks in `@hooks/use-back-button` and `@hooks/use-bottom-button`. **Don't** read `window.Telegram` directly — call SDK functions or use the helpers.
  - Web (other routes): session cookie auth, real DOM buttons.
  - APIs shared by both (e.g. `/api/mail/:id`) → share the same zod schema.
- **Types from `@api/schemas`** (zod-derived); don't redefine types that mirror worker shapes.
- **Hook order**: every `useXxx` must run before any conditional `return` — rules-of-hooks.
- **After changing route file structure**, `bun --filter telemail-page typecheck` runs `tsr generate` to refresh `routeTree.gen.ts`.
