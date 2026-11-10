# Live-trade security review — PR #18

Review target: `live-trade-coordinator-prep` at the current PR head.

## Decision

**NOT APPROVED for Mainnet, signing, or transaction submission.** The coordinator is an isolated reservation primitive, not an end-to-end trading system. Keep the PR in Draft and keep the emergency stop enabled.

## Findings requiring resolution before any live integration

### Critical — no end-to-end live-trade path exists

The Worker does not call `LiveTradeCoordinator`; no route exposes it. The parent branch contains `live-trading.mjs`, which can retrieve and parse an unsigned Jupiter V2 order, but `executeLiveOrder()` deliberately throws and there is no transaction message decoder, signer, submitter, confirmation reconciler, or chain-state settlement verification. This is safe as a preparation prototype, but it does not demonstrate that a live order can be constrained end to end.

### High — quote and risk claims are caller-supplied

`reserve()` currently trusts `solUsd`, `quoteTimestamp`, and `riskPassed` from its request body. A caller that can invoke the Durable Object can provide a fabricated price, timestamp, or `riskPassed: true`. The timestamp check only checks the supplied timestamp; it does not establish the quote's source or authenticity.

Required: obtain the SOL/USD quote inside trusted server-side code from an allowlisted provider; validate currency, positive finite price, response shape, and fetch-time freshness. Run token risk inspection server-side for the exact mint immediately before reservation. Never accept a client boolean as risk approval. The parent `getJupiterOrder()` also accepts an `eligibility` object from its caller; before any integration, its values must be built inside the trusted Worker from fresh scanner data and serialized spend state, never from browser input. Bind the quote and risk evidence to the reservation and order identity.

### High — coordinator endpoints require a provisioned internal credential

The Durable Object now requires a constant-time-checked Bearer credential of at least 32 characters for every endpoint, including status. Missing or invalid credentials receive HTTP 401. The secret is intentionally not configured in this PR or production Worker, so the isolated coordinator remains inaccessible until a trusted server-side integration is separately reviewed. This is defense in depth, not a substitute for operator-only authorization of kill-switch changes.

### High — lifecycle transitions are not chain-verified

`/confirm` accepts a caller assertion without a transaction signature or finalized-chain lookup. `/close` accepts a caller assertion without verified settlement. `/fail` now requires an explicit non-submission assertion and reason, which is a useful guard, but the assertion itself is not independently verified. A future reconciler must query the correct cluster and prove transaction outcome before changing state or releasing capacity.

### High — idempotency now binds the immutable order intent, but caller evidence remains untrusted

The coordinator now requires and compares amount, input mint, output mint, destination, slippage basis points, and quote identity for every idempotency key. Reuse with any changed field is rejected. However, this fingerprint does not authenticate the quote or prove that risk checks ran; those values remain caller-supplied. Do not integrate reservations until trusted server-side quote/risk evidence is generated and bound to the order.

### Medium — reservation history is stored as one unbounded object

The full reservation map is read and rewritten under one storage key. It grows indefinitely and makes each transaction increasingly expensive. Use indexed SQLite tables with bounded retention/archival and database constraints; test migrations and recovery.

### Medium — holder concentration is an approximation

The market inspection resolves only the largest 20 token accounts and aggregates owners represented in that limited set. It does not prove full wallet-level top-10 concentration because a wallet may hold additional token accounts outside the returned set. Label it as an estimate or implement a complete, defensible holder aggregation source before using it as a hard safety gate.

### Medium — external market/risk feeds are not a complete security oracle

DexScreener liquidity/volume/sells and RugCheck score are useful signals, not proof of safe liquidity, fair pricing, ownership, or absence of malicious behavior. The selected highest-liquidity pair is not independently checked for quote-token quality, price impact, pool lock/burn status, or executable exit liquidity. Fail closed on missing, stale, contradictory, or malformed data.

## Existing safeguards verified in code

- Kill switch defaults active.
- Per-trade cap is $3; daily cap is $5; open-position cap is 10.
- Quote timestamp age is limited to 30 seconds, but the timestamp and price are currently caller-supplied.
- Idempotency rejects reuse with a changed lamport amount.
- Ambiguous pending reservations cannot be failed without an explicit non-submission assertion and reason.
- Storage mutations use a Durable Object storage transaction.
- No live route, signing, or transaction submission is present.

## Devnet validation boundary

The Devnet preflight workflow added with this review successfully checked the official Devnet genesis hash, RPC health, confirmed slot, parsed mint data, token program, supply, and a positive SOL/USD spot quote from Coinbase. The reference Devnet USDC mint reports both mint and freeze authorities present, so it would not pass the current strict authority-safety rule. The public Devnet RPC returned HTTP 429 for largest-account enumeration; holder concentration is therefore **not validated**. The Coinbase quote check verifies source connectivity and response schema only; it is not wired into the coordinator's reservation calculation. The workflow performs **zero signing and zero transaction submissions**.

Devnet does not provide representative mainnet liquidity or a dependable market-risk dataset. DexScreener/RugCheck mainnet market results must not be presented as Devnet risk validation. A real Devnet transaction lifecycle test would require an explicitly provisioned Devnet-only test wallet and a separately reviewed transaction harness; no private key or wallet secret is included in this repository change.

## Release gate

Do not merge this PR, enable Mainnet, add a public coordinator route, or enable signing until all High findings are fixed, migrations/recovery are tested, an independent reviewer approves the complete order path, and Devnet-only signed transaction tests pass using a dedicated test wallet.
