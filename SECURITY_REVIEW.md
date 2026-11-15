# Security review — PR #27

Review target: `security/pr26-clean-main` at commit `75b0f0633f1445362caef68b5541b688632ef5f1` (the code revision covered by the passing CI runs below).

## Decision

**NOT APPROVED for Mainnet, signing, transaction submission, or live trading.** This branch remains a paper-trading and security-preparation change. Keep PR #27 in Draft. No merge or production deployment is authorized by this review.

## Current implementation verified

- Paper-trading state is stored in the `PaperTradingState` Durable Object and updated with revision-based compare-and-set operations.
- Authentication state, TOTP counters, backup-code consumption, MFA challenges, and failure buckets are serialized through the `AuthGuard` Durable Object.
- AuthGuard requires an internal Bearer token of at least 32 characters, limits MFA challenges to five minutes and five attempts, and consumes backup codes atomically.
- The Worker enforces same-origin signals for mutating API requests and validates session identifiers before KV lookup.
- The live coordinator obtains SOL/USD and token-risk evidence through trusted server-side code. Browser-supplied quote timestamps, quote IDs, SOL/USD prices, and risk booleans are ignored.
- The latest paper scanner change selects only Solana DexScreener pairs whose `baseToken.address` exactly matches the requested mint.
- RPC response parsing now rejects mismatched IDs, missing results, malformed batch items, and duplicate or missing batch IDs.
- Follow-up hardening in commits `98d1c0f` and `b727605` restricts the root-directory static-assets fallback to `/` and `/index.html`, preventing repository source modules, tests, documentation, and configuration files from being served as static assets; a regression assertion covers this allowlist.
- CI on this commit passed Node tests, frontend syntax validation, and Cloudflare Worker dry-run build validation. Devnet read-only checks passed. The funded signed Devnet transfer step was skipped because `DEVNET_RPC_URL` was not configured.

## Findings blocking any live-trading use

### Critical — no end-to-end live-trade path

The Worker does not call `LiveTradeCoordinator`. There is no production route that reserves, signs, submits, or reconciles a live order. `executeLiveOrder()` deliberately throws. No transaction is signed or submitted.

### High — sell-route verification makes reservations fail closed

`fetchTrustedSellRoute()` requires the expected bot wallet to already own enough of the output token to run a $3 sell probe. That condition normally cannot hold before the first purchase of a new token. In addition, `validateUnsignedJupiterTransaction()` validates transaction wire structure only and explicitly returns `semanticInstructionVerification: false`. The risk evidence consequently cannot satisfy the coordinator's requirement for semantic instruction verification. **Reservations are currently blocked by design.** Do not weaken these checks. A future implementation needs a safe, independently verified exit-route simulation and full instruction/account/program and address-lookup-table decoding.

### High — settlement transitions are disabled

The coordinator's `transition()` method always rejects because independent on-chain settlement proof is not implemented. Confirm, close, and failure transitions cannot safely update state or release capacity. A future reconciler must verify transaction signatures and finalized chain state, or cryptographically establish non-submission, before changing reservation status.

### High — coordinator is isolated and has no trusted caller

The coordinator requires `COORDINATOR_INTERNAL_TOKEN`; the Worker does not call it and the Wrangler file does not configure that secret. This is fail-closed. Any future integration must use a dedicated secret, enforce operator authorization for kill-switch changes, and keep the coordinator inaccessible to browser-controlled requests. Do not expose a public coordinator route.

### High — no funded signed Devnet lifecycle test

The current workflow ran unit/runtime tests and read-only Devnet checks, but skipped the ephemeral signing and faucet-funded transfer step because `DEVNET_RPC_URL` was absent. The workflow's overall success must not be described as proof that a signed transfer or transaction lifecycle was tested.

### Medium — holder concentration and market feeds remain bounded evidence

Trusted live evidence requires paginated Alchemy token-account data and reconciles holder balances to supply before considering concentration. Missing or incomplete data fails closed. DexScreener and RugCheck remain external signals, not proof of safe liquidity, fair price, ownership, or executable exit liquidity. The scanner's top-account concentration estimate in the paper-trading path must not be represented as a complete wallet-level holder census.

### Medium — reservation retention is unbounded

The coordinator stores the reservation map as one object and has no bounded retention/archival strategy. Before any live integration, use a bounded/indexed transactional storage design and test migration, recovery, and long-running growth.

## Authentication review

The reviewed AuthGuard implementation serializes state changes transactionally. Concurrent tests cover one-time backup-code use, one-time TOTP counter acceptance, MFA challenge completion, attempt limits, bounded failure buckets, and one-time legacy initialization. The internal endpoint rejects missing or malformed Bearer credentials and oversized bodies. Runtime secrets and bindings in the deployed Cloudflare environment have not been independently inspected; repository configuration alone does not prove that production secrets are present or correct.

## Deployment and configuration boundary

The checked-in Wrangler configuration declares KV `BOT_STATE`, Durable Objects `LIVE_TRADE_COORDINATOR`, `AUTH_GUARD`, and `PAPER_TRADING_STATE`, plus their migration tags and the `ASSETS` binding. CI validates the configuration and performs a dry-run build only. It does not inspect live Cloudflare account settings or prove that production secrets, namespace bindings, migrations, or cron settings are correctly applied.

## Release gate

Do not merge this PR or enable Mainnet/live trading. Before any separate live-trading proposal, resolve the blocking findings above, verify deployed Cloudflare configuration without exposing secret values, run a dedicated Devnet-only signed lifecycle test with a disposable wallet, test recovery and ambiguous submissions, and obtain independent review of transaction decoding, signing, submission, and settlement reconciliation. Any Mainnet enablement requires separate explicit user approval.


## Review update — 2026-11-15

The earlier review target above is historical. The current code review was refreshed against branch `security/pr26-clean-main` at code commit `a55a90110c93c8beaf9f3a71671b641642207a48`. This documentation update does not change application code.

### Additional hardening verified on the refreshed code

- Static asset requests are configured with `run_worker_first: true`, so requests pass through the Worker before assets can be served. The Worker fallback permits only `/` and `/index.html`; other static paths return 404. A regression test covers the allowlist.
- The dashboard's Token Program field now escapes RPC-derived program-owner metadata before HTML rendering. A regression test checks the safe rendering expression in `index.html`.
- The latest test run completed **103 tests: 103 passed, 0 failed, 0 skipped**.
- Cloudflare Preview reported Build Success and Deployment Success for this code revision. The Preview URL could not be independently reached for runtime verification, so this is not evidence of end-to-end runtime behavior.
- The Devnet workflow's signed/funded transfer step remains skipped because `DEVNET_RPC_URL` is not configured. Read-only Devnet checks and local/runtime tests do not prove a signed transaction lifecycle.

### Outstanding CI and release warnings

- The test job installs Miniflare with `npm install --no-save --ignore-scripts --package-lock=false miniflare@3`. npm reported **5 high-severity vulnerabilities** in the temporary 64-package install. The job log did not include the detailed audit report, so affected packages, advisories, reachability, and remediation are not yet established. Do not run `npm audit fix --force` or claim this warning is resolved without identifying the advisories and validating a compatible fix.
- A legacy Deno Deploy integration status remains failed. The project has moved to Cloudflare; this status is not proof of a Cloudflare Preview failure, but it remains an unresolved repository status check.
- The Preview deployment result does not verify live Cloudflare production secrets, KV namespace bindings, Durable Object migrations, or cron configuration. Those remain outside this repository-only review.

### Refreshed decision

**Still NOT APPROVED for Mainnet, signing, transaction submission, or live trading.** Keep PR #27 in Draft. Do not merge or deploy to production. Paper-trading and the successful CI test suite do not establish live-trading readiness. The blocking findings above, the missing funded Devnet lifecycle test, and the outstanding dependency audit must be addressed in a separately reviewed change before any release decision.


## CI review update — 2026-11-15 (commit 67b0e6f0ffb86a1db5342fc363e058d09c397dd6)

This update supersedes the earlier dependency-audit warning for the exact commit named above; it does not erase the historical findings recorded above.

### Verified GitHub Actions results for this commit

- Node tests: **103 tests, 103 passed, 0 failed**.
- npm audit for the isolated Miniflare test dependency installation: **0 vulnerabilities reported**.
- Cloudflare Worker build validation: **success** (Wrangler dry-run validation; not a production deployment).
- Frontend syntax validation: **success**.
- Devnet read-only cluster/RPC validation: **success**.
- Funded signed Devnet transfer: **skipped**, because `DEVNET_RPC_URL` was not configured. No signed Devnet transaction lifecycle is claimed.
- The workflow job completed successfully; this does not prove production Cloudflare secrets, bindings, migrations, or runtime behavior.

### Current release decision

The successful tests and clean npm audit resolve the specific CI test-runtime audit warning for this commit. They do **not** resolve the live-trading blockers documented above. Keep PR #27 in Draft. No merge, production deployment, Mainnet signing, transaction submission, or live trading is approved. The funded Devnet lifecycle and independent review of live transaction decoding and settlement remain outstanding.
