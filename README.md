# Solana Smart Bot

## Runtime target

Cloudflare Workers is the sole application runtime:
- `worker.js` handles the API and the scheduled paper-trading cycle.
- `wrangler.jsonc` defines the Worker, static assets, KV bindings, and Cron trigger.
- `index.html` is served through the Worker static-assets binding.
- `BOT_STATE` is the Cloudflare Workers KV binding.
- `BOT_LOGIN_PASSWORD` is a Cloudflare Worker secret; never commit its value.

Legacy Deno Deploy (`main.ts` / Deno KV) and the old Node/SQLite API (`server.js`) are not runtime targets. Do not use either to start or deploy the application.

## Local checks

- `npm test` — run the Node test suite.
- `npm run build:check` — build-check the Worker without deploying.
- `npm run dev` — run a local Wrangler development server.

## Cloudflare configuration

Before using a Preview or production environment, verify the correct KV namespace binding and secret are configured for that environment. Keep Preview and production data isolated. A dry-run build does not deploy.

## Data migration — required before retiring the old Deno project

Do not delete the old Deno project or its KV data until the existing paper-trading state has been exported, imported into the intended Cloudflare KV namespace, and read back successfully.

Minimum state to preserve:
- `bot_state` (balance, trades, and any additional persisted paper-trading fields).

Do not migrate active Deno login session tokens. Users should authenticate again on Cloudflare. Never copy passwords, API keys, or other secrets into KV or source control; configure secrets separately in Cloudflare.

The repository does not contain credentials or a verified export of the old Deno KV namespace. Therefore, the state transfer itself remains an operator-controlled cutover step and must be verified against the source before the Deno service is retired.

## Safety boundaries

This project remains in paper-trading mode. These repository changes do not authorize Mainnet trading, wallet signing, swap execution, real-money transactions, production deployment, or merging any pull request.


## Safe Deno KV state transfer

A guarded migration helper is available at `scripts/migrate-deno-state.mjs`. It uses the existing authenticated `GET /api/state` endpoint on Deno and the authenticated `PUT /api/state` endpoint on Cloudflare. It writes a one-time local JSON backup before attempting the import, rejects source data that the Worker would normalize or truncate, then reads Cloudflare state back and compares every source field except the server-managed `updatedAt` timestamp.

Run it from a trusted computer with Node.js 20+; do not paste passwords into source code or commit them:

```sh
DENO_API_URL="https://YOUR-DENO-HOST" \\
CLOUDFLARE_API_URL="https://YOUR-CLOUDFLARE-WORKER-HOST" \\
DENO_LOGIN_PASSWORD="..." \\
CLOUDFLARE_LOGIN_PASSWORD="..." \\
node scripts/migrate-deno-state.mjs
```

The script deliberately stops if either login does not return a session token (for example, if an additional MFA step is required), validates the source state, refuses to overwrite an existing backup file, and does not migrate login sessions or secrets. It does not provide atomic protection against a concurrent Cloudflare state write between the target preflight and import. The Durable Object single-writer design is documented in `docs/adr/0001-paper-state-durable-object-coordination.md` but is not implemented yet. Therefore, do not run this helper against a live or shared namespace until that coordination work is implemented and tested. Keep Deno and its KV data intact until the Cloudflare dashboard is manually checked. Use a Cloudflare Preview environment and its isolated KV namespace first; do not point this helper at production during the test.

This helper is an operator-run migration utility, not a deployment or an automated cutover. It does not deploy, merge, enable live trading, sign wallet transactions, or submit Solana transactions.
