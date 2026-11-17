# Solana Smart Bot

A Solana token scanner with server-authoritative **paper trading**. The current Worker does not submit real transactions.

## Security and deployment checklist

The security changes in PR #27 are not a production deployment approval. Keep the PR unmerged until the required Cloudflare configuration and operational checks below have been completed.

### Required Cloudflare Worker secrets

Configure these in the Cloudflare dashboard or with Wrangler. Never commit their values, paste them into issues, or expose them in logs.

- `BOT_LOGIN_PASSWORD` — administrator login password.
- `AUTH_GUARD_INTERNAL_TOKEN` — random internal credential of at least 32 characters used for Worker-to-AuthGuard Durable Object calls.
- `ALCHEMY_API_KEY` — Alchemy Solana Mainnet API key used by the authenticated scanner to retrieve the complete paginated token-account census. If it is missing or the census cannot reconcile to finalized supply, the scanner fails closed and paper buys are blocked.
- `COORDINATOR_INTERNAL_TOKEN` — independent random internal credential of at least 32 characters for Worker-to-LiveTradeCoordinator calls.
- `COORDINATOR_OPERATOR_TOKEN` — a separate random operator credential of at least 32 characters for emergency-stop control. It must not equal the coordinator internal token.

Example secret setup (Wrangler prompts for each value):

```sh
npx wrangler secret put BOT_LOGIN_PASSWORD
npx wrangler secret put AUTH_GUARD_INTERNAL_TOKEN
npx wrangler secret put ALCHEMY_API_KEY
npx wrangler secret put COORDINATOR_INTERNAL_TOKEN
npx wrangler secret put COORDINATOR_OPERATOR_TOKEN
```

Use independently generated, high-entropy values. Do not reuse the administrator password as the internal token.

### Required bindings

Verify the deployed Worker has the bindings defined in `wrangler.jsonc`:

- KV namespace: `BOT_STATE`
- Durable Object: `AUTH_GUARD`
- Durable Object: `PAPER_TRADING_STATE`
- Durable Object: `LIVE_TRADE_COORDINATOR`
- Static assets: `ASSETS`

The Durable Object migrations in `wrangler.jsonc` must be applied in order. A local build or CI dry-run does not prove that production bindings, migrations, or secrets are configured correctly.

The authenticated dashboard may read `POST /api/live/kill-switch` only to activate the emergency stop (`{ "enabled": true }`); there is deliberately no browser/API path to deactivate it. `GET /api/live/status` reads coordinator status. These controls require both coordinator secrets and the Durable Object binding. The coordinator remains isolated: there is still no public reservation, signing, swap, or Mainnet transaction route.

### Verification before any production release

1. Confirm the production Worker name, route/domain, KV namespace ID, and all Durable Object bindings in the Cloudflare dashboard.
2. Confirm both required secrets are present without revealing their values.
3. Run the repository test suite: `npm test`.
4. Confirm the Cloudflare Worker build validation and Devnet read-only checks pass for the exact commit being considered. The funded signed Devnet transfer step is skipped unless a dedicated DEVNET_RPC_URL is configured; a successful workflow does not prove that a signed transfer was tested.
5. Verify login, MFA enrollment and recovery, logout/revocation, paper buy, paper sell thresholds, and one-time legacy-state migration in a non-production environment.
6. Review Cloudflare logs for errors without logging credentials, session tokens, MFA secrets, backup codes, or API keys.

### Live trading remains disabled

The Worker now exposes authenticated coordinator status and a one-way emergency-stop activation endpoint only. It still exposes no reservation, signing, swap, or live-order route. Settlement transitions fail closed until independent on-chain transaction verification, complete all-in cost accounting, and replay-safe settlement are implemented and tested. Do not enable live trading, remove its kill switch, or treat a successful Devnet test as authorization for Mainnet activity.

## Development

Requires Node.js 20 or newer.

The active application is the Cloudflare Worker in `worker.js`; the legacy SQLite `server.js` is not the application entry point.

```sh
npm install
npm start       # local Wrangler Worker development server
npm test
```

`npm start` and `npm run dev` run Wrangler against `wrangler.jsonc`. They do not deploy to production. For an explicit preview build without deployment, use:

```sh
npx --yes wrangler@4 deploy --dry-run --config wrangler.jsonc
```
