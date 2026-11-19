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
