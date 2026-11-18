# Mainnet live-trading implementation gate

## Current status

This repository currently implements paper trading only. The scheduled Worker updates simulated positions and simulated balance. It does not construct, sign, or submit Solana transactions.

This branch is preparation and policy enforcement only. It does not enable live trading and must not be deployed as a live trader.

## Required architecture

1. Keep the existing paper-trading engine unchanged.
2. Keep the live-trading module separate and default-off.
3. Use a dedicated bot wallet only. The personal wallet must never be used as the server signer.
4. Keep signing material out of GitHub, browser code, KV state, logs, error messages, and chat.
5. Before selecting a signer, verify the exact Solana transaction format, key custody model, and Cloudflare Workers compatibility. Do not accept a private key through an HTTP request.
6. Quote and swap through a supported Solana swap provider, validate the returned transaction and all account/program destinations, then sign and submit only after every policy check passes.
7. Verify confirmed transaction status and reconcile actual token/SOL balances from RPC. Never treat a quote or successful HTTP response as a completed trade.

## User-requested initial trade cap (not yet operational)

The user selected a maximum of **USD $3 per buy**, a maximum cumulative spend of **USD $5 per day**, and a maximum of **10 simultaneous open positions**. These are requested limits only; they are not active, deployed, or enforced by the current Worker. The daily cap must be enforced atomically across concurrent requests and Cron retries. Before implementation, the server must convert the USD cap to lamports using a trusted, fresh SOL/USD price with conservative rounding, and reject the trade if the price is unavailable or stale. Slippage, liquidity/volume thresholds, and other risk controls still require explicit review. Do not infer or enable those settings from the user's selected position count.

## Implemented fail-closed policy checks in this branch

- LIVE_TRADING_ENABLED must be exactly true; missing or malformed configuration disables live trading.
- LIVE_TRADING_KILL_SWITCH must be exactly false; otherwise live trading is disabled.
- Dedicated wallet public key must exactly match the pinned expected public key.
- Per-trade spend, daily spend, open-position count, maximum slippage, minimum liquidity, and minimum 24-hour volume must be explicit bounded values.
- evaluateLiveTradeEligibility enforces the per-trade cap, cumulative daily spend cap, open-position cap, minimum liquidity, minimum volume, and explicit passing results for mint authority, freeze authority, Token-2022 extension safety, holder concentration, and sell-route availability.
- getJupiterOrder requires eligibility data and rejects a trade before network access if any check is missing or fails.
- Jupiter response parsing rejects malformed Base64 syntax, non-positive output, missing route data, and mismatched input/output mint or input amount.
- Execution remains intentionally unimplemented; no transaction is signed or submitted.

Eligibility values must come from trusted, fresh server-side scanner and persisted trading state. Do not accept these values from browser input. The branch now contains a SQLite-backed Durable Object coordinator with internal bearer authentication, immutable-intent idempotency, serialized reservation state, kill-switch state, per-trade and daily USD limits, open-position limits, trusted server-side SOL/USD and token-risk evidence, and bounded unsigned Jupiter transaction structure parsing. The parser validates transaction wire structure and resolves v0 address lookup tables from finalized RPC state, including ownership, activation, warmup, index bounds, and duplicate-key checks. It deliberately does not semantically verify instruction programs/accounts. The coordinator therefore rejects every reservation until semantic instruction verification is independently implemented. Settlement transitions are also deliberately disabled until transaction submission status or cryptographic proof of non-submission can be independently established. The current Worker does not call the coordinator; no public coordinator route or live execution path is wired. The paper-trading Worker continues to use its separate paper-state Durable Object.

### Additional all-in spend accounting gate

The current $3 per-buy and $5 per-day reservation accounting converts only the SOL input amount to USD cents. It does not yet include verified maximum priority fees, base transaction fees, Jupiter submission tips, account rent/creation, or other possible SOL/token outflows. Therefore these figures are not yet an all-in spend or maximum-loss ceiling. Before any live reservation can be approved, independently decode every value-moving instruction, calculate a conservative maximum for all fees/outflows, and atomically reserve the complete all-in amount against the same daily budget. For v1, validate Jupiter's `computeUnitPrice` against an explicitly reviewed ceiling before converting it to priorityFeeLamports. Do not invent or silently default a fee ceiling.

### Verified production-evidence gap (do not confuse fixtures with live evidence)

The current `fetchTrustedLiveEvidence()` production provider returns only `quote`, `risk`, and `passed`. It does not return a `costs` object. Its Jupiter sell-route result is quote/build-envelope and transaction-structure evidence only; it does not set `semanticInstructionVerification: true` or `routeVerification: "semantically-verified"`. Consequently, the production provider cannot satisfy the coordinator's semantic-verification and all-in-cost reservation gates. Unit-test fixtures that include these fields are synthetic test inputs, not evidence that production analysis has implemented either capability. Keep reservations blocked until independently validated production evidence is implemented and tested end to end.

The current PR adds regression coverage that removes either semantic route attestation or all-in cost evidence from otherwise passing synthetic evidence and asserts that reservation is rejected without changing open-position or daily-spend state. Settlement tests also reject missing or mismatched finalized all-in cost fields rather than confirming a position. These tests prove the coordinator's fail-closed behavior only; they do not prove the production provider can generate trusted semantic or cost evidence.

## Mandatory remaining release gates

1. Complete independent semantic verification of Jupiter instruction programs/accounts. Transaction wire parsing and finalized address lookup-table resolution are implemented, but do not establish that the resolved instructions are safe.
2. Establish quote freshness and validate all relevant amounts, fees, and token programs.
3. Complete and independently test the existing Durable Object coordinator's durable idempotency and settlement state machine, including restart recovery and duplicate Cron/request behavior.
4. Wire an authenticated emergency stop into the same strongly coordinated component and prove that it blocks new reservations immediately; define safe exit behavior.
5. Test RPC outages, provider errors, ambiguous submissions, partial confirmations, and restart recovery.
6. Complete a Devnet-only signing/submission test using a disposable wallet and tiny test amount.
7. Obtain independent review of signing and transaction-decoding code.
8. Have the user review final limits and explicitly approve before any Mainnet enablement.

## Not implemented here

No live signer, private-key handling, Jupiter/DEX swap execution, Mainnet transaction submission, or automatic real-money trading is implemented by this branch. Do not add a wallet secret or deposit funds based on this preparation branch.


### Explicit priority-fee ceiling configuration

The coordinator requires `LIVE_MAX_PRIORITY_FEE_LAMPORTS` to be explicitly configured as a non-negative safe integer and rejects any computed priority fee above it. There is intentionally no default value and no production ceiling is selected by this repository change. Until an operator reviews the fee policy and configures this value, reservation attempts fail closed. A test-only fixture value is used solely for unit tests and must not be copied as an operational recommendation. This setting alone does not make fee evidence trustworthy: instruction semantics and all-in outflow decoding remain mandatory blockers.

### Test-fixture limitation: settlement cost fallback

The coordinator unit-test helper in `tests/live-trade-coordinator.test.mjs` wraps its injected settlement verifier and, when that verifier omits a `costs` property, synthesizes a cost breakdown from the test fixture. This convenience is test-only and must not be interpreted as production settlement evidence. In particular, a passing coordinator confirmation test that uses this helper does not prove that `verifyFinalizedJupiterSettlement()` derives or verifies fees and native SOL outflows. The direct verifier test in `tests/trusted-live-evidence.test.mjs` currently asserts that the returned proof has no `costs`, `allInCosts`, native SOL outflow, base fee, priority fee, rent, tip, or total-lamport fields. Keep production settlement blocked until those values are independently derived from finalized transaction metadata and checked against the reserved all-in cost breakdown. Any future test of the production settlement path must inject the real verifier without a synthetic-cost adapter.


## Readiness checkpoint — 2026-11-18, PR #43 head `7e5261bf4f5d7955c359b0d0f66720d4f82b7b95`

The exact head passed:
- Node tests: run `44395541512` — success.
- Cloudflare Worker build validation: run `44395541434` — success.
- Devnet read-only validation: run `44395541377` — success.
- Funded Devnet lifecycle: skipped (job `135124792134`).

The successful CI result does not establish a signed buy/sell lifecycle. The funded Devnet job was skipped, and no signer or submission flow exists. The Worker entry point remains the paper-trading Worker; `live-trading.mjs` only retrieves and structurally validates an unsigned Jupiter order, while `executeLiveOrder()` intentionally throws without signing or submitting. The coordinator is not wired to a live Worker route.

The user has authorized preparation for future real-money trading, not funding, signing, submission, production deployment, PR merge, or Mainnet activation. Keep all those actions disabled until the acceptance gates and a separate explicit release approval are complete. Do not change UI/design.



## Readiness checkpoint — 2026-11-19, PR #43 head `febb9a6a45773b2c2597ec404804f1dba2d3ac3d`

The exact current PR head is open and Draft. It has not been merged.

Latest GitHub Actions results for this exact head:
- Node tests: run `44416144265` — success.
- Cloudflare Worker build validation: run `44416144290` — success; Wrangler dry-run only, no deployment.
- Devnet read-only validation: run `44416144261` — success, including unit/runtime tests and Devnet cluster identity/read-only RPC checks.
- Funded Devnet lifecycle: skipped by the workflow gate; no funded transaction was run.

The latest ATA PDA hardening changes also passed Node tests and the Worker build. They reject accessor-backed derivation inputs without invoking getters, as well as inherited or unexpected fields.

### Remaining work — still release-blocking

1. **Semantic transaction verification:** decode and validate every instruction in the supported Jupiter swap route, exact account roles/privileges, route amounts, destinations, and any CPI/inner-instruction effects. Current parsers and isolated decoders are analysis-only; do not promote them to semantic approval.
2. **All-in cost evidence:** connect independently verified message-bound fees, priority fee, tips, rent, and every possible SOL/token outflow to immutable order intent and atomic spend reservation. The production evidence provider still does not supply trusted all-in costs.
3. **Authenticated execution evidence:** verify signatures, transaction identity, confirmed/finalized metadata, and blockhash/quote expiry; safely reconcile ambiguous or partial submissions.
4. **Settlement and recovery:** complete owner-scoped SOL/WSOL/SPL/Token-2022 balance-delta reconciliation, durable restart recovery, duplicate request/Cron handling, and idempotent ledger updates.
5. **Signer integration:** Turnkey remains a selected candidate only. The SDK/adapter has not been installed or validated in workerd. First perform a no-secret mocked compatibility spike; then independent signer-side policy enforcement and transaction-only adapter review.
6. **Operational controls:** prove the emergency kill switch blocks reservations and signing, define safe exit behavior, test RPC/provider outages, and complete an independent security review.
7. **Separate release approvals:** only after the above gates, obtain explicit approval for a disposable-wallet funded Devnet lifecycle, then separately for production deployment and Mainnet activation.

Until these are complete, keep the coordinator reservation gate closed, keep `executeLiveOrder()` non-executing, and keep Mainnet trading disabled. The passing checks establish code/test/build and read-only Devnet status only; they do not establish live-trading readiness.

No UI/design changes, merge, production deployment, wallet enrollment, signing, transaction submission, or funded Devnet operation occurred in this checkpoint.


## Readiness checkpoint — 2026-11-19, PR #43 head `2b393c61ffe0c6513bd5d58d98c166981ce16aca`

The exact PR head completed all three configured CI workflows successfully:
- Node tests: run `44416739801` — success.
- Cloudflare Worker build validation: run `44416739659` — success.
- Devnet read-only validation: run `44416739657` — success. This job ran unit tests, real Durable Objects runtime tests, and Devnet cluster identity/read-only RPC checks.
- Funded Devnet lifecycle: skipped by the explicit opt-in gate; no funded transaction or signing test was performed.

The Jupiter unsigned-order response now explicitly reports `analysisOnly: true`,
`signingPermitted: false`, and `submissionPermitted: false`; its semantic
verification flag remains false. Regression tests assert this non-authorizing
contract. These checks do not complete Jupiter route semantics or make live
execution available.

PR #43 remains open and Draft. No merge, production deployment, wallet
signing, transaction submission, or Mainnet activation occurred. The UI and
design remain unchanged.
