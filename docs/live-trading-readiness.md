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


## Evidence reservation collision guard (latest preparation)

The ledger now treats evidence-bearing and non-evidence reservations as distinct immutable records. If a duplicate idempotency key has the same request fingerprint but one record carries an evidence digest and the other does not (or the digests differ), it returns a conflict rather than reporting a duplicate success. Regression coverage checks both evidence-to-plain and plain-to-evidence reuse. This prevents a pre-existing plain reservation from being mistaken for a verified evidence reservation. The change is branch-only; its newest CI run is being checked. It does not enable execution.

## Holder concentration gate (implemented; complete enumeration still required)

The Worker uses a tested fail-closed helper to aggregate validated parsed token-account amounts by wallet owner with BigInt. It verifies mint, token-program owner (SPL Token or Token-2022), unique account address, and equality between largest-account RPC amount and parsed account amount. It only treats the distribution as complete when the validated sample sums exactly to the mint's raw total supply. If the RPC's top-20 sample is partial, or account data is missing/inconsistent, inspection rejects the mint rather than trusting an understated concentration result. Owner concentration thresholds use exact integer comparisons.

CI run [45537712305](https://github.com/hesamtanya75-stack/solana-smart-bot/actions/runs/45537712305) passed: 136 tests, 136 passed, 0 failed; Worker/DO syntax and Wrangler dry-run also passed. The current conservative gate can reject tokens whose full supply is not represented in the top-20 response. A future live-readiness step must implement full mint/token-program-aware account enumeration with pagination and slot consistency, reconcile the complete supply, and retain both token-program support. This is still preparation only; no live order is authorized.

## Full token-account holder enumeration (implemented, bounded and fail-closed)

The Worker now queries `getProgramAccounts` for both the legacy SPL Token program and Token-2022, filtering by mint at the base token-account mint offset and requesting only the owner+atomic-balance data slice. It requests finalized commitment with context for both enumerations and mint supply, and requires all three context slots to match exactly. The parser validates account program ownership, data encoding/slice size, unique public keys, and sums every enumerated raw balance with BigInt; the total must equal the RPC mint supply. Zero-balance accounts are excluded from concentration ranking. The validated full set is then aggregated by owner and checked against the existing concentration thresholds.

This is bounded to 50,000 accounts per mint to avoid unbounded response/memory processing. If an RPC provider truncates or caps a response, the slot contexts differ, the account count exceeds the limit, malformed data is returned, or the total does not reconcile, the mint is rejected (fail-closed). RPC providers must support context-wrapped `getProgramAccounts` and the data-slice request. Unit tests cover both token programs, exact-slot requirement, supply reconciliation, malformed slices and duplicate accounts. CI run #102 passed 140/140 tests; Worker and Durable Object syntax checks and Wrangler deployment dry-run (no deployment) also passed. This does not prove the user's configured Preview RPC providers support these query sizes or response formats. A configured read-only Preview integration test remains required before this evidence can be relied upon. No transaction signing or submission is enabled.

## Quote provider allowlist is a consistency check, not provenance proof

The evidence attestation now requires the quote object's provider label to be exactly `jupiter-swap-v2`, matching the current server-side quote client, and a regression test rejects unexpected provider labels. This prevents an arbitrary provider label from being accepted by the attestation shape. It does **not** authenticate the upstream response or prove quote correctness: the quote remains explicitly classified `provider-response-unverified`. Do not interpret HMAC integrity as external-provider authenticity or live execution authorization.

The pure order-policy gate was tightened to require `quote.evidenceClass === "provider-response-authenticated"` in addition to the caller's `trusted` flag and freshness checks. Regression tests confirm that a `trusted: true` boolean cannot promote `provider-response-unverified` or missing provenance. The current Jupiter client still emits only `provider-response-unverified`, so **no current quote can satisfy this stricter gate**; this is intentional fail-closed behavior until upstream authenticity/verification is implemented and independently tested. The authenticated class is a reserved policy contract, not a claim that such verification exists today.

## Fail-closed complete holder concentration calculation

The Worker now uses a separate tested helper to aggregate parsed token-account balances by wallet owner with BigInt. It verifies each account's mint, token-program owner (SPL Token or Token-2022), unique account address, and equality between the largest-account RPC amount and parsed account amount. Concentration is considered complete only when the validated account sample sums exactly to the mint's raw total supply; if the RPC returns only a partial top-20 sample, missing account data, mismatched fields, or an incomplete total, the inspection fails closed and no paper purchase is recorded for that mint. The thresholds are compared using integer parts-per-million to avoid floating-point boundary drift.

This conservative check may reject tokens whose supply is distributed across more than the RPC's 20 largest-account entries. It intentionally does not claim a full distribution in that case. A future complete owner aggregation must enumerate all token accounts for the mint with pagination/slot consistency, handle both token programs, and reconcile the full supply before relaxing this blocker. Tests cover multiple token accounts belonging to one owner, SPL Token and Token-2022, partial supply, duplicate accounts, mismatched mint/program, and amount inconsistencies. This is risk-evidence preparation only; it does not authorize or execute trades.
