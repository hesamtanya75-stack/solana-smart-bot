# Deno KV to Cloudflare Workers KV migration

## Status and safety boundary

This document describes a controlled, one-time migration. It does not perform an export,
write to either KV namespace, change the dashboard, or deploy a Worker. Keep the Deno
service and its KV database intact until the imported state has been independently
verified. Never put passwords, session tokens, private keys, or API secrets in an export
committed to Git or shared in a pull request.

## Confirmed source and destination keys

The current Deno service opens `Deno.openKv()` and stores paper-trading state at the
Deno KV tuple key `["bot_state"]`. Its session records use tuple keys
`["sessions", token]` with `{ expiresAt }` values and a seven-day expiry.

The Cloudflare Worker reads and writes the Workers KV string key `bot_state` in the
`BOT_STATE` namespace. It stores login sessions under `session:<token>`. These are
different key layouts and session formats; do not copy Deno session records. Users
should sign in again after cutover so fresh Cloudflare sessions are issued.

## Required migration procedure

1. Freeze paper-trading writes briefly, or take a consistent point-in-time export while
   the Deno service is not mutating `["bot_state"]`.
2. Export only the value at `["bot_state"]` from the Deno KV database. Keep the export
   private and outside the repository.
3. Validate the export before any write:
   - It must decode to one JSON object.
   - `balance` must be a finite number greater than or equal to zero.
   - `trades` must be an array with no more than 500 entries.
   - Preserve the complete trade objects and the original `updatedAt` value.
   - Record a cryptographic checksum of the exact export for audit.
4. Inspect the destination Workers KV namespace and confirm whether `bot_state` already
   exists. If it exists, stop and compare it; never overwrite a populated destination
   automatically.
5. Import the validated object as JSON at the exact Workers KV key `bot_state` in the
   intended namespace. Use a dry-run first and require an explicit operator confirmation
   before the write.
6. Read the destination value back and compare its normalized state, trade count,
   balance, and checksum/canonical JSON against the source export.
7. Only after successful comparison, switch traffic and sign in again. Keep the source
   export and Deno KV backup until the operator confirms the paper-trading history is
   present in the dashboard.

## Important compatibility details

The Worker adds defaults for fields not present in the older Deno state, including
`autoEnabled: false`, `paused: false`, `scannedMints`, and scan-report metadata.
Missing fields must receive safe defaults; importing must never turn on automated
paper buying. Do not enable live trading: the migration is data-only and must not sign
or submit any Solana transaction.

The browser's `demoTradingData` localStorage fallback is a separate migration path. It
does not prove that Deno KV data has been copied. Do not treat a successful browser
login or a newly initialized Workers KV value as evidence that the Deno history was
preserved.

## Cutover acceptance checklist

- [ ] A private, consistent Deno `["bot_state"]` export exists.
- [ ] Source export passes schema and size validation.
- [ ] Destination namespace and existing key were checked.
- [ ] Import was explicitly authorized and performed once.
- [ ] Destination read-back matches the source state and trade history.
- [ ] Dashboard displays the expected balance and trades after fresh login.
- [ ] Deno KV backup remains available until operator sign-off.
- [ ] No production deployment, wallet signing, or Mainnet transaction was part of this procedure.


## Newly identified cutover blocker: Cron can pre-create empty state

The Worker scheduled handler calls `readState()` and then always calls `saveState()`,
even when the `bot_state` key did not previously exist and no trade data was imported.
That write adds a fresh `updatedAt` timestamp to the default state.

The dashboard's `finishServerLogin()` migrates browser `demoTradingData` only when
the returned remote state has no `updatedAt`. If the one-minute Cron runs first, the
newly-created default state has `updatedAt`, so the browser migration branch is skipped
and the empty/default server state is applied instead. This can strand local browser
paper-trading history even though the login itself succeeds.

This is a separate issue from Deno KV migration. The cutover must not assume that
`updatedAt` proves a human or migration process initialized the state. Before enabling
Cron on a fresh namespace, implement and test an explicit initialization marker or
source marker (for example, distinguish `stateInitialized` from the routine
`updatedAt` timestamp). The browser migration decision must be based on a verified
initialization/source marker and must fail closed if both local and remote histories
exist and differ. Do not silently overwrite either copy.

Required regression tests:
- Empty Workers KV followed by one or more scheduled runs still permits the intended
  localStorage migration path.
- An explicitly imported Deno state is recognized as initialized and is not overwritten
  by browser defaults.
- A pre-existing local history and a populated remote history produce a conflict that
  requires an explicit resolution; neither side is silently discarded.
- Cron defaults keep `autoEnabled` false and never initiate live trading.
