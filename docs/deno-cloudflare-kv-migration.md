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
