# Direct Email Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Cloudflare Queue and deliver provider notifications directly in background work while atomically preventing duplicate Telegram sends.

**Architecture:** D1 stores a transient `(account_id, email_message_id)` claim until a delivery either establishes a permanent `message_map` row or becomes explicitly ambiguous. All providers and unread sync use one sequential background dispatcher, while the existing Telegram Durable Object continues to pace API calls and the ten-minute unread scan retries safe failures.

**Tech Stack:** TypeScript, Cloudflare Workers, D1/Drizzle, Durable Objects, Elysia, Vitest Workers pool

## Global Constraints

- Work on branch `feat/direct-email-delivery`.
- Do not commit unless the user explicitly asks for a commit.
- Use `(account_id, email_message_id)` as the only automatic-delivery idempotency key.
- Prefer at-most-once behavior for an ambiguous Telegram response.
- Keep successful historical delivery state in `message_map`, not `email_deliveries`.
- Preserve provider abstractions and the existing observability path.
- Every production behavior starts with a failing test.

---

### Task 1: Add the transient D1 delivery claim repository

**Files:**
- Create: `apps/worker/migrations/0030_create_email_deliveries.sql`
- Modify: `apps/worker/src/db/schema.ts`
- Create: `apps/worker/src/db/email-deliveries.ts`
- Create: `apps/worker/vitest.config.ts`
- Create: `apps/worker/test/apply-migrations.ts`
- Create: `apps/worker/test/env.d.ts`
- Create: `apps/worker/test/tsconfig.json`
- Create: `apps/worker/test/email-deliveries.test.ts`
- Modify: `apps/worker/package.json`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces: `ensureEmailDeliveryPending(d1, accountId, emailMessageId): Promise<void>`
- Produces: `claimEmailDelivery(d1, accountId, emailMessageId): Promise<boolean>`
- Produces: `markEmailDeliveryRetryable(...)`, `markEmailDeliveryUnknown(...)`, `deleteEmailDelivery(...)`, and `deleteEmailDeliveriesByAccountId(...)`

- [ ] **Step 1: Install the Workers Vitest pool and add test scripts**

Add `vitest@^4.1.0` and `@cloudflare/vitest-pool-workers` to the Worker workspace dev dependencies. Add `"test": "vitest run"` to `apps/worker/package.json` and `"test:worker": "bun --filter telemail-worker test"` to the root scripts.

- [ ] **Step 2: Configure real D1 migration tests**

Use `cloudflareTest`, `readD1Migrations`, and `applyD1Migrations` so tests execute the repository against a Miniflare D1 binding loaded from the checked-in migrations.

- [ ] **Step 3: Write the failing repository tests**

Test these independently derived behaviors:

```ts
it("allows only one pending delivery to claim the same email", async () => {
  await ensureEmailDeliveryPending(env.DB, 1, "message-1");
  expect(await claimEmailDelivery(env.DB, 1, "message-1")).toBe(true);
  expect(await claimEmailDelivery(env.DB, 1, "message-1")).toBe(false);
});

it("allows a retryable delivery to be claimed again", async () => {
  await ensureEmailDeliveryPending(env.DB, 1, "message-2");
  await claimEmailDelivery(env.DB, 1, "message-2");
  await markEmailDeliveryRetryable(env.DB, 1, "message-2");
  expect(await claimEmailDelivery(env.DB, 1, "message-2")).toBe(true);
});
```

- [ ] **Step 4: Run the tests and verify RED**

Run: `bun --filter telemail-worker test -- email-deliveries.test.ts`

Expected: FAIL because the migration and repository module do not exist.

- [ ] **Step 5: Add the migration, schema, and minimal repository**

The migration creates a composite primary key and checked state:

```sql
CREATE TABLE email_deliveries (
  account_id INTEGER NOT NULL,
  email_message_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sending', 'retryable', 'unknown')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (account_id, email_message_id)
);
```

Implement claims with a conditional `UPDATE ... WHERE state IN (...)` and return whether D1 changed a row. `ensureEmailDeliveryPending` must use `ON CONFLICT DO NOTHING` so it never resets `sending` or `unknown`.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run: `bun --filter telemail-worker test -- email-deliveries.test.ts`

Expected: PASS.

---

### Task 2: Add the pre-send delivery coordinator

**Files:**
- Create: `apps/worker/src/utils/mail-delivery/coordinator.ts`
- Create: `apps/worker/test/mail-delivery-coordinator.test.ts`
- Modify: `apps/worker/src/utils/mail-delivery/deliver.ts`

**Interfaces:**
- Produces: `coordinateEmailDelivery(operations): Promise<EmailDeliveryOutcome>`
- Produces: `EmailDeliveryResult = "sent" | "skipped" | "not-claimed"`
- Changes: `deliverEmailToTelegram(..., options?)` accepts an optional async `beforeSend` gate and returns `EmailDeliveryResult`

- [ ] **Step 1: Write failing coordinator tests**

Use real in-memory state transitions and a fake only for the external Telegram send. Assert consumer-visible outcomes:

```ts
it("allows one of two concurrent attempts to send", async () => {
  const [first, second] = await Promise.all([
    runAttempt(),
    runAttempt(),
  ]);
  expect([first, second].sort()).toEqual(["not-claimed", "sent"]);
  expect(sentMessageCount).toBe(1);
});

it("marks a claimed failure unknown and refuses a later send", async () => {
  await expect(runFailingAttempt()).rejects.toThrow("network lost");
  expect(state).toBe("unknown");
  expect(await runAttempt()).toBe("not-claimed");
});
```

Also cover permanent mapping cleanup, pre-claim failure remaining pending, and successful transient cleanup.

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun --filter telemail-worker test -- mail-delivery-coordinator.test.ts`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement the minimal coordinator and send gate**

The coordinator must:

1. Short-circuit an existing mapping and clean a stale claim.
2. Ensure `pending` before external preparation.
3. Pass an atomic claim callback to `deliverEmailToTelegram`.
4. Delete the claim on `sent` or `skipped`.
5. Leave pre-claim failures pending.
6. Mark known initial Telegram rate-limit failures `retryable`; if a visible
   message already exists, persist its mapping and report later attachment
   failures without retrying the whole email. Mark other post-claim failures
   `unknown`, unless a mapping now exists.

Call the optional `beforeSend` only after parsing, state reconciliation, content formatting, and initial keyboard creation, immediately before the first Telegram API operation.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun --filter telemail-worker test -- mail-delivery-coordinator.test.ts`

Expected: PASS.

---

### Task 3: Replace Queue email producers with the shared direct dispatcher

**Files:**
- Create: `apps/worker/src/utils/mail-delivery/dispatch.ts`
- Create: `apps/worker/test/mail-delivery-dispatch.test.ts`
- Modify: `apps/worker/src/providers/base.ts`
- Modify: `apps/worker/src/providers/gmail/index.ts`
- Modify: `apps/worker/src/providers/outlook/index.ts`
- Modify: `apps/worker/src/providers/imap/index.ts`
- Modify: `apps/worker/src/handlers/email/index.ts`
- Modify: `apps/worker/src/api/modules/providers/index.ts`
- Modify: `apps/worker/src/utils/mail-sync.ts`
- Modify: `apps/worker/src/handlers/scheduled/tasks/sync-unread-mail.ts`
- Modify: `apps/worker/src/bot/handlers/sync.ts`
- Modify: `apps/worker/src/bot/index.ts`
- Modify: `apps/worker/src/api/modules/telegram/index.ts`
- Modify: `apps/worker/src/types.ts`

**Interfaces:**
- Produces: `scheduleEmailDeliveries(env, requests, waitUntil): number`
- Produces: `processEmailDeliveries(env, requests): Promise<void>`
- Produces: shared `WaitUntil = (promise: Promise<unknown>) => void`
- Consumes: Task 1 repository and Task 2 coordinator

- [ ] **Step 1: Write the failing batch behavior test**

Prove duplicate keys in one input batch are processed once and distinct keys are processed sequentially. The production mutation caught is removing the stable-key `Map` or changing the loop to `Promise.all`.

- [ ] **Step 2: Run the test and verify RED**

Run: `bun --filter telemail-worker test -- mail-delivery-dispatch.test.ts`

Expected: FAIL because the dispatcher does not exist.

- [ ] **Step 3: Implement direct sequential processing**

Move the Queue consumer's account validation, raw-message fetch, delivery-status filtering, stale-message handling, and observability into `dispatch.ts`. Register exactly one handled promise with the bound `waitUntil` callback per provider batch.
Bound each invocation to ten messages and a 20-second claim-start budget so
the remaining unread messages are deferred to the ten-minute fallback instead
of overrunning HTTP `waitUntil`.

- [ ] **Step 4: Wire every producer**

Rename provider `enqueue` methods/comments to direct dispatch terminology and pass the bound runtime callback from HTTP, Email Routing, scheduled sync, and bot sync contexts. Preserve the manual sync result count while renaming internal `enqueued` fields to `scheduled`.

- [ ] **Step 5: Run all Worker tests**

Run: `bun test:worker`

Expected: PASS.

---

### Task 4: Remove the remaining Queue dependency

**Files:**
- Delete: `apps/worker/src/handlers/queue/index.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/types.ts`
- Modify: `apps/worker/src/bot/handlers/admin/index.ts`
- Modify: `apps/worker/src/bot/utils/admin.ts`
- Modify: `apps/worker/src/utils/accounts.ts`
- Modify: `apps/worker/wrangler.jsonc`
- Modify: `apps/worker/wrangler.example.jsonc`
- Regenerate: `apps/worker/worker-configuration.d.ts`
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/ENVIRONMENT.md`

**Interfaces:**
- Removes: `EMAIL_QUEUE`, `QueueMessage`, `QueueMessageType`, and the module `queue()` handler
- Consumes: `deleteEmailDeliveriesByAccountId` during account cleanup

- [ ] **Step 1: Replace the delayed administrator-message deletion**

Pass the bound runtime `waitUntil` callback into admin handler registration. Change the secret display lifetime to 20 seconds and schedule `deleteMessage(...)` through `waitUntil(sleep(...).then(...))`, reporting failure with the existing observability helper.

- [ ] **Step 2: Remove Queue code and configuration**

Delete the Queue handler and message types, remove `EMAIL_QUEUE` from the refined binding type, remove Wrangler producer/consumer blocks, and remove the module export's `queue()` handler.

- [ ] **Step 3: Extend account cleanup**

Delete all transient delivery claims when deleting an account.

- [ ] **Step 4: Update user-facing documentation**

Remove Queue provisioning and binding instructions. Describe direct background delivery, the existing Durable Object limiter, and the ten-minute unread fallback.

- [ ] **Step 5: Regenerate and validate config-derived types**

Run: `bun typegen:worker`

Run: `bun --filter telemail-worker check:wrangler`

Expected: generated `Cloudflare.Env` contains no `EMAIL_QUEUE`, and the real/example Wrangler configs stay aligned.

---

### Task 5: Final verification and review

**Files:**
- Review all changed Worker source, migrations, configs, tests, and docs

- [ ] **Step 1: Run the full test suite**

Run: `bun test:worker`

Expected: all tests pass with no warnings or unhandled rejections.

- [ ] **Step 2: Run repository checks**

Run: `bun check`

Run: `bun typecheck`

Expected: both exit successfully; the existing Biome schema-version informational messages are acceptable.

- [ ] **Step 3: Inspect migration and working tree**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff --stat`

Expected: no whitespace errors, no unrelated files, and no Queue binding references outside historical design/plan text.

- [ ] **Step 4: Perform a Workers best-practices review**

Check full changed files for bound `waitUntil` use, handled promises, binding/config consistency, request-scoped state, serializable boundaries, and structured error reporting. Do not claim completion until any HIGH/MEDIUM findings are resolved.
