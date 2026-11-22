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

### Solana RPC configuration

The Worker accepts a dedicated provider endpoint through the Cloudflare secret `SOLANA_RPC_URL`. Configure it in **Workers & Pages → solana-smart-bot-new → Settings → Variables and Secrets → Add secret** (or with `wrangler secret put SOLANA_RPC_URL`). Use a provider-issued HTTPS Mainnet RPC URL; do not paste the value into GitHub, source files, screenshots, or logs.

`SOLANA_RPC_URL` is tried first, followed by the existing `ALCHEMY_API_KEY` setting and public fallback endpoints. Public RPCs are rate-limited shared infrastructure and may return HTTP 403/429 from Worker traffic; they are a development fallback, not a production reliability guarantee. The Worker reports provider labels and HTTP status/Retry-After without logging the secret URL. A configured private RPC is still required to verify reliable scanner operation.

## Data migration — required before retiring the old Deno project

Do not delete the old Deno project or its KV data until the existing paper-trading state has been exported, imported into the Cloudflare `PAPER_STATE_COORDINATOR` Durable Object, and read back successfully.

Minimum state to preserve:
- `bot_state` (balance, trades, and any additional persisted paper-trading fields).

Do not migrate active Deno login session tokens. Users should authenticate again on Cloudflare. Never copy passwords, API keys, or other secrets into KV or source control; configure secrets separately in Cloudflare.

The repository does not contain credentials or a verified export of the old Deno KV namespace. Therefore, the state transfer itself remains an operator-controlled cutover step and must be verified against the source before the Deno service is retired.

## Safety boundaries

This project remains in paper-trading mode. These repository changes do not authorize Mainnet trading, wallet signing, swap execution, real-money transactions, production deployment, or merging any pull request.


## Safe Deno KV state transfer

A guarded migration helper is available at `scripts/migrate-deno-state.mjs`. It uses the existing authenticated `GET /api/state` endpoint on Deno. On Cloudflare it first checks the authenticated `GET /api/state/status` endpoint for authoritative Durable Object initialization metadata, then calls the authenticated `POST /api/state/import` endpoint. The import operation is atomic and refuses to overwrite any initialized state; canonical paper state is not written to Workers KV. It writes a one-time local JSON backup before attempting the import, validates the legacy source fields, fills Worker-only fields with explicit safe defaults (auto-buy disabled and unpaused), rejects unsupported fields or oversized arrays, then reads Cloudflare state back and compares every original source field except the server-managed `updatedAt` timestamp.

Run it from a trusted computer with Node.js 20+; do not paste passwords into source code or commit them:

```sh
DENO_API_URL="https://YOUR-DENO-HOST" \\
CLOUDFLARE_API_URL="https://YOUR-CLOUDFLARE-WORKER-HOST" \\
DENO_LOGIN_PASSWORD="..." \\
CLOUDFLARE_LOGIN_PASSWORD="..." \\
node scripts/migrate-deno-state.mjs
```

The script deliberately stops if either login does not return a session token (for example, if an additional MFA step is required), validates the source state, refuses to overwrite an existing backup file, and does not migrate login sessions or secrets. The target's one-time import is atomic inside the Durable Object, so a concurrent initializer cannot replace or partially overwrite it. The Worker API, automation updates, and Cron cycle now use the Durable Object's versioned commit boundary; stale Cron results are rejected. This repository-level test coverage does not replace a Cloudflare runtime test or a controlled Preview cutover. Therefore, do not run this helper against production or a shared namespace until the isolated Preview integration and data verification are complete. Keep Deno and its KV data intact until the Cloudflare dashboard is manually checked. Use a Cloudflare Preview environment and its isolated KV namespace first; do not point this helper at production during the test.

This helper is an operator-run migration utility, not a deployment or an automated cutover. It does not deploy, merge, enable live trading, sign wallet transactions, or submit Solana transactions.

## Legacy Deno Deploy status check

The repository no longer contains a Deno application entrypoint or a Deno Deploy workflow. A GitHub commit status named `deploy/hesamtanya75-stack/solana-smart-bot-17` can still appear because the legacy Deno Deploy project is connected to this repository outside GitHub Actions. The current reported failure, `Organization suspended - resolve billing to deploy`, is returned by Deno Deploy; it is not a Worker test or Wrangler build failure and cannot be repaired by changing application source code.

Safe resolution:
1. Keep the Deno project and its KV data intact until the state cutover is completed and independently verified.
2. If the Deno service must continue deploying during the transition, the Deno organization owner must resolve the suspension/billing issue in the Deno account. Do not add Deno runtime files back to this repository to mask the status.
3. After the Cloudflare Preview has passed its isolation and persistence checks and the Deno state has been migrated and read back successfully, disconnect or disable the legacy Deno project's GitHub auto-deploy integration in the Deno project settings. This stops future Deno deployment attempts without requiring deletion of the Deno project or its KV data.
4. Only retire the Deno project and its KV data after a separate manual confirmation that the Cloudflare dashboard contains the complete expected paper-trading state.

A historical Deno failure status may remain attached to older commits. Do not treat it as evidence that Cloudflare Worker tests failed. Cloudflare Preview deployment and runtime validation remain separate required checks.


## Automated isolated Preview

A guarded GitHub Actions workflow is available at `.github/workflows/cloudflare-preview.yml`. It runs only for same-repository pull requests targeting the migration base branch and only when the repository Actions variable `CLOUDFLARE_PREVIEW_ENABLED` is exactly `true`. It requires the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository Actions secrets. The workflow runs tests and a Wrangler dry-run before invoking the Wrangler Preview command; it does not deploy Production. See [the Preview validation checklist](docs/cloudflare-preview-runtime-validation.md) for setup and isolation requirements.
