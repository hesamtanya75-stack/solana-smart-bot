# Controlled Deno Deploy to Cloudflare Workers cutover

## Scope and current status

Cloudflare Workers is the target runtime (`worker.js` + `wrangler.jsonc`). The legacy Deno service (`main.ts` + `Deno.openKv()`) remains the source of truth until its paper-trading state has been exported, imported, and read-back verified. This change does not delete the Deno source, disable its deployment, change DNS, or deploy either platform.

The current Deno API stores paper state at the tuple key `["bot_state"]`; Cloudflare's `PaperTradingState` Durable Object is the destination. Deno login sessions are deliberately not migrated. Sign in again after cutover.

## One-time controlled migration

Run this from a trusted computer with Node.js 20+. Do not put passwords, TOTP codes, tokens, or the exported state in Git, chat, issue comments, or shell history. Use a private terminal and environment variables populated through a secure prompt or secret manager.

Required environment:
- `DENO_API_URL`: optional override; defaults to `https://solana-smart-bot-17.hesamtanya75-stack.deno.net`.
- `CLOUDFLARE_API_URL`: optional override; defaults to the confirmed production Worker `https://solana-smart-bot-new.hesamtanya75.workers.dev`.
- `DENO_LOGIN_PASSWORD`: Deno administrator password.
- `CLOUDFLARE_LOGIN_PASSWORD`: Cloudflare administrator password.
- `CLOUDFLARE_TOTP_CODE`: only if Cloudflare MFA is enabled; one current code.

Optional:
- `STATE_BACKUP_FILE`: private backup path; defaults to `deno-bot-state-backup.json`. The file is created with exclusive-create semantics and mode 0600. Choose a new path for each deliberate retry.
- `CONFIRM_DEFAULT_SOURCE_STATE=YES`: required only when Deno returns the default-looking state (balance 100 and no trades). The legacy Deno GET API cannot distinguish an absent KV key from a deliberately empty default state, so inspect the Deno dashboard/KV first.

Run:

```sh
node scripts/migrate-deno-to-cloudflare.mjs
```

The script:
1. Logs into Deno and reads only `/api/state`.
2. Validates the balance, trade count, and every supported trade field. It stops instead of silently dropping unknown fields.
3. Writes a private, exclusive-create JSON backup and prints its SHA-256 checksum.
4. Logs into Cloudflare (including the optional TOTP challenge).
5. Requires the Cloudflare API to report `canMigrateLegacy: true` and a valid revision.
6. Uses the existing authenticated, revision-checked one-time `PUT /api/state` legacy migration route. It does not write directly to Workers KV.
7. Reads Cloudflare state back and compares the balance and complete normalized trade history. Automated paper buying remains disabled and the imported bot is paused for manual review.

If any step fails, the script stops. Keep Deno running and retain the backup. Do not repeatedly retry against an initialized destination; investigate and reconcile first.

## Pre-cutover checks

- Confirm Cloudflare's production/preview Worker URL and bindings are correct.
- Confirm `PAPER_TRADING_STATE` Durable Object is eligible for one-time migration.
- Confirm the Deno state is not changing during export/import; pause paper-state writes or choose a quiet window.
- Ensure no user-facing traffic is switched until read-back verification and a manual dashboard check pass.
- Confirm the Deno source and KV backup remain available through operator sign-off.

## Cutover completion is an operator action

A successful script run proves only that the supported state was imported and read back from the specified Cloudflare Worker. It does not switch DNS, delete the Deno project, disable the Deno deployment, configure production secrets, or deploy Cloudflare. Those actions require a separate, explicit operational cutover after the dashboard and balances/trades are manually checked.

Never migrate Deno session tokens. Never put secrets in source control. No wallet signing, transaction submission, Mainnet trading, or funded Devnet lifecycle is part of this migration.
