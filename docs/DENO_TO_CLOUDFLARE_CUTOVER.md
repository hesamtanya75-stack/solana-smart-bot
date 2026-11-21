# Controlled Deno Deploy to Cloudflare Workers cutover

## Scope and current status

Cloudflare Workers is the target runtime (`worker.js` + `wrangler.jsonc`). The legacy Deno service (`main.ts` + `Deno.openKv()`) remains the source of truth until its paper-trading state has been exported, imported, and read-back verified. This change does not delete the Deno source, disable its deployment, change DNS, or deploy either platform.

The current Deno API stores paper state at the tuple key `["bot_state"]`; Cloudflare's `PaperTradingState` Durable Object is the destination. Deno login sessions are deliberately not migrated. Sign in again after cutover.

## Suspended Deno app: export directly from KV (read-only)

If the Deno app endpoint is suspended but the managed KV database still permits external access, use the native Deno KV Connect path instead of the app's `/api/state` login endpoint. This uses the production key `["bot_state"]` confirmed in `main.ts`; it does not write to KV.

1. In Deno Deploy, copy the actual database ID for the production database `f91810-production` from its details (not `f91810-local`, a timeline label, or a preview database).
2. Create an organization access token under organization Settings → Access Tokens. Keep it private.
3. In a trusted Node/Deno terminal, set `DENO_KV_DATABASE_ID` and `DENO_KV_ACCESS_TOKEN` as environment variables. Do not put the token in source, command history, GitHub comments, or chat.
4. Run the read-only exporter:

```sh
deno run --allow-env=DENO_KV_DATABASE_ID,DENO_KV_ACCESS_TOKEN,STATE_BACKUP_FILE,CONFIRM_DEFAULT_SOURCE_STATE --allow-net=api.deno.com --allow-write=. scripts/export-deno-kv-paper-state.ts
```

It fails closed if the production key is missing, the state is invalid, or the result looks like the default (balance 100, no trades) without explicit confirmation. It creates a new owner-only backup file, prints its SHA-256 and trade count, and never prints the state or token. It performs no KV mutation, Cloudflare write, deployment, or cutover.

If the export succeeds, point the existing guarded migration at that verified file by setting `DENO_STATE_FILE` to its path, then run `node scripts/migrate-deno-to-cloudflare.mjs` with the Cloudflare login/MFA environment configured securely. The migration script creates a second private backup before attempting the one-time Cloudflare import and performs full read-back verification. If the KV Connect request is denied by the suspended organization, stop; do not detach/delete the database or upgrade/pay without the account owner's decision.

## Console-exported production database (iPhone-friendly fallback)

The Deno Console export UI may provide a completed SQLite-format Deno KV database file. The export completion table is only confirmation that the file was generated; save the downloaded file privately from Safari Downloads/Files first.

1. Confirm the export row says database `f91810-production`, format `SQLite`, and status `completed`. Do not use `f91810-local`.
2. Download the file to the iPhone Files app. Treat it as sensitive production data; do not attach it to chat, commit it, or upload it to a public repository.
3. In the repository's GitHub Codespace (opened on the migration branch), create a folder named `private-export` in the Explorer. Use the Explorer `...` menu → **Upload Files** (or right-click the folder → **Upload**) and select the SQLite file from iPhone Files → Downloads. Keep it inside `private-export`; this folder is ignored by `.gitignore`. Do not use GitHub's repository upload/commit UI. Confirm the filename in the Explorer. The workspace path is `/workspaces/solana-smart-bot/private-export/<actual-file-name>`. Run the offline read-only extractor against that file:
   ```sh
   deno run --allow-read=./private-export --allow-write=. scripts/extract-deno-kv-export.ts ./private-export/<actual-file-name>
   ```
   Replace `<actual-file-name>` with the exact filename shown in Codespaces. The generated JSON backup is also ignored by `.gitignore`. The script opens the exported KV database locally, reads only the exact `["bot_state"]` key, validates supported fields, and writes a private JSON state backup with SHA-256 and trade count. It does not print the state, modify the SQLite file, connect to Deno, or write to Cloudflare.
4. If the extraction succeeds, keep both the original SQLite export and the JSON backup private. The next migration step requires a separate explicit operator action; do not run the Cloudflare import until the extracted balance/trade count are checked and the destination's eligibility/revision are confirmed.

If the exported file cannot be opened by the pinned/current Deno KV runtime, stop and preserve it. Do not try to edit the SQLite file or use generic SQLite tools to rewrite it.

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
