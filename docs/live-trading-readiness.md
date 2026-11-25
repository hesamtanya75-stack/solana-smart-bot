# Live Trading Readiness — Working Preparation

This branch is preparation only. It is not a live-trading release and does not enable signing, swap submission, automatic trading, or deployment.

## Verified current behavior

- The Worker is the Cloudflare runtime (`worker.js`).
- The discovery and risk pipeline is in `inspectMint()`; it checks market liquidity/volume, mint and freeze authority, holder concentration, RugCheck, and selected Token-2022 extensions.
- `autoBuy()` currently subtracts a fixed simulated amount and records `mode: "paper"`. It does not request a Jupiter swap quote, build a swap transaction, sign it, or submit it.
- `refreshTrades()` closes simulated positions using price thresholds and updates the paper balance. It does not execute an on-chain sell.
- State is coordinated through the `PAPER_STATE_COORDINATOR` Durable Object. This paper state must not be treated as a real wallet balance or real position ledger.
- `/health` currently reports `mode: "paper-trading"`.
- The authorized `/api/state` interface can update paper-state fields, including the simulated balance. This is not a wallet balance endpoint and must remain isolated from any future live ledger.
- The scheduled handler only calls the paper `refreshTrades()` and `autoBuy()` paths. It must not be repurposed to submit live orders until a separate execution and authorization design is implemented.

## Scope of the current policy helper

The branch's `validateLiveOrderPolicy()` is a local fail-closed input validator only. It checks the shape and freshness of supplied evidence; a `trusted: true` flag or `passed: true` value does not prove who produced that evidence or that it was tamper-resistant. The helper also checks that an idempotency key is present and bounded, but it does not store keys or prevent replay by itself. Before any execution path exists, quote/risk provenance must be authenticated server-side and idempotency must be enforced with durable, atomic order-state storage and reconciliation.

## Implementation acceptance checklist

A live execution implementation is not complete until all of these are implemented and tested:

1. Separate real-wallet positions and accounting from paper state; never infer wallet funds from the paper balance.
2. Define explicit operator-configured limits: per-order spend, daily spend, open positions, slippage, estimated total transaction fee, and emergency pause.
3. Require fresh, trusted quote and token-risk evidence at order time; reject stale, missing, malformed, or inconsistent evidence.
4. Build and validate the swap transaction from a trusted provider; verify input/output mints, amount, recipient, minimum output, and fee bounds before signing.
5. Keep signing material out of Worker source, KV, logs, GitHub, and browser storage. Use a supported secure signing boundary or explicit wallet approval; never accept a seed phrase/private key through the dashboard.
6. Simulate where supported, then submit only under the configured authorization policy; record signature and confirmation state idempotently.
7. Handle timeout/unknown submission status without blindly resubmitting; reconcile signatures and balances before retrying.
8. Implement real sell execution and reconciliation, not price-only paper closures.
9. Add unit tests, mocked provider integration tests, failure/replay/idempotency tests, and isolated Preview validation.
10. Keep live mode disabled by default. No production deployment, merge, or live order is performed by this preparation branch.

## Safe operational sequence

- Continue implementation and automated tests on this branch.
- Validate in isolated Preview with no funded wallet and no production state migration.
- Review all limits, wallet/signing model, and transaction authorization before any funded test.
- Production activation and actual trades require a separate explicit operation approval.


## Numeric and address validation boundaries

The policy helper now converts its daily-spend ledger, order amount, estimated fee, and configured daily cap to integer lamports before summing and comparing. This avoids floating-point boundary drift in daily spend checks, and values that cannot be represented safely at lamport precision fail closed. The quote-input comparison still uses a numeric tolerance and remains a preparation-only check, not execution-grade amount binding. The eventual execution path must use `live-order-units.js` decimal-string conversion end-to-end for SOL and token atomic units; it must not use floating-point values as authoritative transaction or accounting amounts.

The Base58 mint check currently verifies only a plausible character set and string length. It does not decode the address to confirm exactly 32 bytes, prove that the account exists, or verify its on-chain owner and token-program type. Those checks must be performed against trusted chain data before any live order is authorized.


## Evidence provenance is not established by this validator

The policy helper only validates fields supplied to it. In particular, `quote.trusted === true` and `riskEvidence.passed === true` are caller-provided assertions, not cryptographic or server-side proof of origin. Do not connect this helper directly to transaction signing or submission. A future order service must fetch or independently verify the quote and risk response from approved server-side sources, bind the evidence to the exact mints and amount, and prevent client-side replacement between validation and execution. The helper's freshness checks are necessary but not sufficient for live authorization.


## Exact amount conversion helper (isolated)

The branch now includes `live-order-units.js`, which converts plain decimal strings to integer atomic units using explicit decimals, and converts integer units back to a canonical decimal string. SOL helpers use 9 decimals (lamports). The module rejects JavaScript Number inputs, signs, exponent notation, excess fractional precision, invalid decimal counts, and negative/non-BigInt atomic values. It is covered by `tests/live-order-units.test.mjs` and included in the dedicated Node 20 policy-test workflow. This utility is not yet wired into the Worker, quote provider, order ledger, or transaction path; it does not authorize or execute trades.


## Order lifecycle and retry safety (isolated rules)

The branch includes a pure lifecycle helper with the statuses `created`, `validated`, `submitted`, `reconciliation_required`, `confirmed`, `failed`, and `rejected`. It disallows skipping directly from validation to terminal confirmation, requires a signature once submission is recorded, and blocks blind resubmission for submitted or uncertain orders. An uncertain submission must be reconciled by signature before it can be marked confirmed or failed. This is only a state-transition validator: it is not a durable ledger, does not enforce unique idempotency keys across requests, and is not wired to the Worker or any RPC/signer. Durable atomic storage and actual chain reconciliation remain required before execution.


## Strict order-record schema

The lifecycle validator now rejects unsupported top-level order fields and validates optional finalization timestamps and failure-reason length. This prevents arbitrary caller-supplied fields (including accidental secret-bearing properties) from being accepted into the isolated ledger record. It is a schema boundary, not a substitute for authenticated request construction or secret scanning.

## Isolated transactional ledger adapter

An additional `live-order-ledger.js` adapter uses a Durable Object-style transactional storage interface to atomically create an order record, reject reuse of an idempotency key with a different request fingerprint, and compare-and-swap status transitions by version. Its unit tests use a serialized in-memory storage stub only; they do not prove Cloudflare runtime behavior or cross-instance production guarantees. The adapter remains unbound and unwired, does not independently authenticate or calculate the request fingerprint, and cannot sign, send, or confirm a transaction. It is groundwork, not live trading readiness.


## Daily-spend precision regression and CI

The policy regression suite now includes an exact daily-limit boundary and a just-over-limit case. The validator compares spend in integer lamports rather than adding JavaScript floating-point SOL values. The dedicated `Live Order Policy Tests` workflow passed on the current preparation head (`531a79bc2bea63e0b75e6c4ab5abe049e5ac8e73`). This confirms the isolated Node test suite only; it does not certify a wallet, signer, transaction builder, live buy/sell, or Mainnet readiness.


## Terminal lifecycle requires explicit reconciliation metadata

The lifecycle validator now requires a terminal confirmed or failed record to carry a positive reconciliation timestamp and a reconciliation result matching that terminal status, in addition to its signature and finalization timestamp. This prevents the pure state helper or ledger transition API from marking an order terminal with only a generic status change. The metadata is still caller-supplied: it does not prove an RPC lookup occurred and is not an authenticated chain receipt. Actual server-side signature/balance reconciliation and trusted provenance remain prerequisites before execution.


## Read-only Solana signature reconciliation adapter

Added `solana-signature-reconciler.js`, an injected-RPC read-only adapter using `getSignatureStatuses` with transaction-history search. It reports `confirmed` or `failed` only when the signature is finalized; absent or non-final statuses remain `pending`. RPC transport and malformed responses fail closed. Unit coverage is included in the dedicated policy CI workflow. This adapter does not submit transactions, authenticate a provider's response, persist lifecycle state, or independently prove that an authorized execution path sent the transaction; integration with trusted ledger records and server-side evidence is still pending.


## Server-side ledger reconciliation gate (isolated)

The LiveOrderLedger now rejects direct confirmed/failed transitions. Terminal updates must use its reconcile(orderId, expectedVersion) method with a server-injected signature reconciler. The method reads the stored signature from the uncertain order, calls the injected read-only RPC adapter outside the storage transaction, requires evidence to echo the exact signature, and leaves non-final statuses pending. For finalized outcomes it performs a version-checked transactional commit and stores the reconciled terminal state. Stale versions, mismatched signatures, malformed evidence, RPC failures, and missing finalized slots fail closed.

The adapter/ledger integration is still an isolated library boundary and is not wired to a Worker route or live order submission. The injected reconciler must be constructed only in trusted server code; never expose it as a client-controlled callback or accept reconciliation metadata from dashboard/API input. These tests use mocked RPC/storage and do not constitute a funded-chain or production Durable Object integration test.


## HMAC evidence binding (isolated preparation)

Added `live-order-evidence-attestation.js` to HMAC-SHA-256 attest a server-constructed evidence envelope. The signed payload binds an idempotency key, exact input/output mints, atomic input amount, the quote response, and the risk snapshot; verification checks the expected order binding, signature, and expiry. The helper rejects unsupported quote provenance, stale/failed risk data, malformed bindings, and modified payloads. Tests are included in the dedicated Node 20 workflow.

This is an integrity/authentication primitive only when its signing secret is held exclusively by trusted server code and signing is performed only after independently obtaining and validating provider/risk evidence. It is not yet called by a Worker route, does not establish that the underlying quote/risk source is correct, and does not authorize a transaction. Keep the HMAC secret out of browser code, KV state, logs, and source control. No transaction signing or submission was added.


## Read-only finalized wallet balance and position reconciliation

The authenticated Worker exposes `POST /api/wallet/reconcile`, accepting exactly one field: a public Solana owner address. It validates the base58 address as a 32-byte public key, reads native SOL balance and SPL Token + Token-2022 accounts at `finalized` commitment, and aggregates raw token atomic amounts with `BigInt` to avoid floating-point loss. Empty/zero token accounts are omitted; malformed or oversized token-account responses fail closed rather than return a partial portfolio. The endpoint reports the RPC context slots and explicitly notes that these separate reads are not an atomic single-slot snapshot.

No wallet secret or signing capability is accepted. This endpoint does not mutate paper state, open positions, the live-order ledger, or execute trades. It is a backend read-only capability; it has not been connected to or visually surfaced in the dashboard. CI includes mocked reconciliation tests and Worker syntax validation. A configured Cloudflare Preview RPC integration test remains outstanding.

## Authenticated evidence preparation + Durable Object reservation (isolated)

The authenticated Worker route `POST /api/live-order/evidence` accepts only the idempotency key, input/output mint, and positive atomic-unit amount. The Worker independently inspects the output token and obtains a Jupiter quote using server-side configuration; `LIVE_ORDER_EVIDENCE_HMAC_SECRET` binds that evidence and `JUPITER_API_KEY` remains server-only.

Before returning success, the Worker forwards the binding and HMAC attestation to the internal `LIVE_ORDER_LEDGER` Durable Object. The isolated SQLite Durable Object verifies the HMAC again and atomically reserves the idempotency key through `LiveOrderLedger.create()`. The ledger stores a request fingerprint, `created` status, evidence digest, and evidence issue/expiry times—not the raw provider payload, transaction, or signature. A repeated identical request returns the existing reservation; key reuse with a different binding conflicts. Concurrent duplicate requests are covered by a serialized transaction test. The ledger also refuses to advance evidence-only records from `created` into `validated` or any later execution lifecycle; an explicit `rejected` transition remains available.

The response remains `mode: read-only-evidence` and `execution: not-authorized`. This is a durable **evidence reservation**, not a submitted or executable trade. It does not build a swap transaction, accept a wallet/private key, sign, submit, change paper balance, or create a real position. The Worker and Durable Object bindings are declared in `wrangler.jsonc`; syntax and 71 Node tests passed on the last verified test run. Wrangler configuration dry-run validation is now in CI; it is not a deployment. Cloudflare Preview integration with configured secrets remains outstanding. Keep this branch undeployed and live execution disabled.
