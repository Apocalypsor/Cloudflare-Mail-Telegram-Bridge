# Direct Email Delivery Design

## Goal

Remove the Cloudflare Queue dependency while preventing repeated provider
notifications from sending the same email to Telegram more than once. Keep the
existing Telegram Durable Object as the rate-limit gate and use the ten-minute
unread-mail scan as the delivery fallback.

## Constraints

- Gmail Pub/Sub, Outlook Graph, IMAP forwarding, manual sync, and scheduled
  unread sync must use the same delivery path.
- The stable idempotency key is `(account_id, email_message_id)`, not a provider
  notification ID.
- A normal successful delivery must not leave a row in the transient delivery
  table.
- Prefer avoiding a duplicate over automatically retrying a Telegram request
  whose outcome is unknown.
- Do not mark ordinary delivered email as read; the existing `message_map`
  remains the long-lived record that an unread email was delivered.
- Do not add a replacement durable queue, Workflow, or new Durable Object.

## Architecture

### Transient delivery claims

Add an `email_deliveries` D1 table with a composite primary key on
`(account_id, email_message_id)`. Its states are:

- `pending`: known not to have started a Telegram send and safe to retry.
- `sending`: one invocation atomically claimed the right to send.
- `retryable`: a positively identified pre-send failure may be retried.
- `unknown`: Telegram may have accepted the request; automatic retries are
  disabled to favor at-most-once delivery.

Every source first ensures a `pending` row exists. Immediately before the first
Telegram send, delivery performs a compare-and-set from `pending` or
`retryable` to `sending`. Only the invocation that updates one row may call
Telegram. Concurrent notifications fail the compare-and-set and stop before
sending.

After a successful send, `message_map` is written first and the transient row
is deleted second. That ordering is safe: if cleanup fails, future attempts see
the permanent mapping and remove the stale claim without sending. Account
deletion cascades to all transient claims, and the claim update requires the
account to still exist and be enabled.

### Direct background processing

Replace Queue producers with a shared scheduler that accepts provider-native
message IDs and a bound `waitUntil` callback. It deduplicates each input batch
and processes messages sequentially to avoid turning the Telegram limiter into
an in-memory backlog. One invocation starts at most ten deliveries and stops
claiming new mail after a 20-second background budget, leaving the ten-minute
unread scan to pick up the remainder within Workers' 30-second HTTP
`waitUntil` limit.

The shared processor performs these steps:

1. Load and validate the account.
2. Stop if a permanent `message_map` already exists, cleaning any stale claim.
3. Ensure the transient `pending` row exists.
4. Fetch the raw email and current remote state.
5. Parse and prepare the Telegram payload.
6. Atomically claim the delivery immediately before Telegram is called.
7. Send through the existing `TelegramRateLimiter` Durable Object.
8. On success, keep the mapping and delete the transient claim.

Errors before the claim leave the row `pending`, so the ten-minute unread scan
can retry. A known initial Telegram rate-limit failure after the claim becomes
`retryable`; once the initial visible message exists, a later attachment
failure keeps the mapping and is reported without retrying the whole email. A
genuinely ambiguous initial send becomes `unknown` unless the mapping already
exists. Missing/provider-404 or out-of-INBOX messages delete their transient
claim. A `sending` row older than two minutes is conservatively reconciled to
`unknown` so a canceled invocation cannot leave an active-looking claim
indefinitely.

### Provider and sync entry points

- Gmail and Outlook webhooks pass their bound `waitUntil` callback into their
  provider dispatch methods and return after scheduling background delivery.
- The Email Routing handler does the same for IMAP.
- Manual sync and the ten-minute scheduled sync call the same scheduler.
- All provider batches are processed sequentially inside one background task.

### Removing the remaining Queue use

The Queue also delays deletion of the administrator secrets message by 60
seconds. Replace that one-off delayed message with a 20-second `waitUntil`
timer, safely below Workers' 30-second post-response background limit. A
failure is reported through the existing observability path and is not retried.

Remove the Queue handler, Queue message types, generated binding type, Wrangler
producer/consumer configuration, deployment instructions, and environment
documentation.

## Data lifecycle

- Successful delivery: mapping persists; transient claim is deleted.
- Safe pre-send failure: `pending`/`retryable` remains until a later signal or
  unread sync retries it.
- Ambiguous send: `unknown` remains to prevent a duplicate and provide an audit
  signal.
- Canceled send: stale `sending` becomes `unknown` rather than risking a
  duplicate retry.
- Account deletion: all claims for the account are deleted by D1 cascade.
- Intentional redelivery paths continue to remove/reset their permanent mapping
  explicitly and do not use the automatic notification claim.

The table therefore scales with outstanding failures, not historical mail.

## Error handling and observability

- Report each direct-delivery failure with account ID, email message ID, claim
  state, and whether a permanent mapping exists.
- Preserve the existing handling for delivery-status messages and stale remote
  messages.
- Keep the post-send unique mapping check as a final defensive guard, but the
  normal repeated-notification path must be stopped by the pre-send claim.

## Testing

Add focused tests that prove:

- two concurrent attempts for the same key allow exactly one send;
- a permanent mapping skips Telegram and cleans a stale claim;
- a pre-claim failure remains retryable by a later invocation;
- an error after claiming becomes `unknown` and is not resent;
- success writes the mapping and removes the transient claim;
- duplicate IDs within a provider batch are processed once;
- known rate-limit failures become retryable, while ambiguous failures do not;
- a later multi-attachment failure preserves the initial mapping and does not
  resend the email;
- real D1 claims gate the injected Telegram send and mapping exists before
  transient cleanup;
- account disable/delete races cannot acquire or orphan a claim;
- batch size and deadline stop new claims before the `waitUntil` limit.

Run the focused test suite, `bun check`, `bun typecheck`, the Wrangler template
check, and regenerate Worker binding types after removing the Queue binding.
