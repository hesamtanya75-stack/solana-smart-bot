# ADR: Single-writer coordination for paper-trading state

Status: Accepted; branch implementation complete, remote Preview runtime validation pending
Applies to: Cloudflare Worker migration branch
Safety: paper-trading only; no wallet signing, swaps, or Mainnet transactions

## Context

Before this branch's refactor, the Worker stored the canonical paper-trading document at KV key `bot_state`. The migration branch now routes canonical paper-trading state through `PaperStateCoordinator`; Workers KV remains for unrelated sessions, profile data, and caches.
The current code has multiple read-modify-write paths:
- `PUT /api/state`
- `POST /api/automation`
- the scheduled Cron cycle (trade refresh, paper buys, then save)
- helper functions that call `saveState`

KV does not provide an atomic compare-and-swap for this read/modify/write sequence. A KV lock key is not a safe substitute: competing isolates can both believe they acquired it, and a lease does not protect writers that do not honor it. The Cron cycle also performs external network requests between reading and saving, so holding a simplistic lock for the entire cycle would be fragile.

## Decision

Use one Durable Object instance as the serialization and authoritative storage boundary for the paper-trading state. Do not treat KV as the writable canonical state after the cutover.

The branch implementation exposes narrowly scoped operations:
1. `GET snapshot`: return the current state and monotonically increasing version.
2. `PATCH state`: apply an allow-listed user change inside a Durable Object Storage transaction.
3. `COMMIT cycle`: accept a computed Cron result only when its expected version equals the current version; update state and increment version atomically. On conflict, reject the stale result. Do not blindly overwrite or automatically replay a cycle that may have calculated paper buys/sells from an old snapshot.
4. `IMPORT once`: import a validated Deno snapshot only when the Durable Object has no state and no prior import marker. Write the state and import marker in the same storage transaction. Any existing state/marker means abort.
5. `STATUS`: report initialized/version/imported metadata without exposing secrets.

All Worker code paths that read or mutate canonical paper-trading state (API routes and Cron) must use this boundary. No direct `BOT_STATE.put("bot_state", ...)` or read-modify-write through KV may remain. KV can continue to hold unrelated sessions, profile data, and caches during this stage.

## Cron concurrency

Cron reads a versioned snapshot, performs network lookups and computes a candidate state, then submits a conditional commit with the original version. If an API update or another cycle committed first, the stale cycle is rejected and logged. It must not overwrite the newer state. A rejected cycle may be retried only by starting a fresh cycle from a new snapshot, with explicit idempotency protections for any paper-trade decisions.

The coordinator must never hold an open Durable Object transaction while calling DexScreener, RugCheck, or Solana RPC.

## Migration safeguards

- Keep Deno and its KV namespace intact.
- Export and back up Deno state before any import.
- Validate the complete source document against Worker normalization limits.
- Require explicit operator confirmation if Deno's API cannot distinguish an absent KV key from a default-looking state.
- Import only into a provably uninitialized Durable Object; the import marker and imported document are atomic.
- Verify the complete document after import, excluding only the server-managed timestamp/version fields.
- Do not copy sessions, passwords, API keys, or TOTP secrets.
- Do not delete or disable Deno after import; require a separate manual dashboard verification and recovery window.

## Validation status and remaining requirements

The migration branch currently includes in-memory transactional coordinator tests, Worker routing tests, strict API payload validation, stale Cron commit rejection, Preview binding-isolation checks, and a Wrangler Worker/DO dry-run build. The CI run for the current pre-documentation head passed. These tests do not substitute for an actual Cloudflare Preview runtime test: the test coordinator uses an in-memory storage implementation rather than Cloudflare's deployed Durable Object runtime.

Before considering the new path operational, deploy only an isolated Cloudflare Preview and verify its health route, first-time initialization, snapshot, PATCH, versioned COMMIT conflict, and persistence across Preview redeploys. Confirm the Preview KV namespace differs from Production. Do not use production bindings or Deno credentials in this test.

## Required tests before enabling the new path

- Concurrent PATCH requests do not lose either update.
- Two COMMIT requests with the same expected version: exactly one succeeds.
- A stale Cron result cannot overwrite a newer dashboard update.
- Cron does not initialize an empty state.
- IMPORT succeeds once only; concurrent/repeated imports cannot overwrite.
- IMPORT aborts if any target state or import marker exists.
- An exception during import leaves neither a partial state nor a success marker.
- Invalid/oversized source state is rejected before import.
- API and Cron have no direct canonical KV writes after refactor.
- Existing paper-trading tests and Wrangler dry-run build pass.

## Rollout boundary

This ADR does not authorize deployment, remote KV access, a real Deno-to-Cloudflare import, production changes, PR merge, funded Devnet actions, wallet signing, swaps, or Mainnet trading. Keep live trading disabled.
