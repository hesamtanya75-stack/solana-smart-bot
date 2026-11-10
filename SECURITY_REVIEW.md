# Live-trade security review — PR #18

Review target: `live-trade-coordinator-prep` at the current PR head.

## Decision

**NOT APPROVED for Mainnet, signing, or transaction submission.** The coordinator is an isolated reservation primitive, not an end-to-end trading system. Keep the PR in Draft and keep the emergency stop enabled.

## Findings requiring resolution before any live integration

### Critical — no end-to-end live-trade path exists

The Worker does not call `LiveTradeCoordinator`; no route exposes it; there is no transaction builder, signer, submitter, confirmation reconciler, or chain-state settlement verification. This is safe as an isolated prototype, but it does not demonstrate that a live order can be constrained end to end.

### High — quote and risk claims are caller-supplied

`reserve()` currently trusts `solUsd`, `quoteTimestamp`, and `riskPassed` from its request body. A caller that can invoke the Durable Object can provide a fabricated price, timestamp, or `riskPassed: true`. The timestamp check only checks the supplied timestamp; it does not establish the quote's source or authenticity.

Required: obtain the SOL/USD quote inside trusted server-side code from an allowlisted provider; validate currency, positive finite price, response shape, and fetch-time freshness. Run token risk inspection server-side for the exact mint immediately before reservation. Never accept a client boolean as risk approval. Bind the quote and risk evidence to the reservation and order identity.

### High — coordinator endpoints have no local authorization

The Durable Object's `fetch()` accepts `/reserve`, `/confirm`, `/fail`, `/close`, and `/kill-switch` without checking an internal credential. There is currently no public Worker route to the namespace, so this is not presently an internet-exposed route. Nevertheless, do not add a public route or call these handlers from untrusted/browser input. Before integration, authenticate every internal operation and restrict kill-switch changes to trusted operator code.

### High — lifecycle transitions are not chain-verified

`/confirm` accepts a caller assertion without a transaction signature or finalized-chain lookup. `/close` accepts a caller assertion without verified settlement. `/fail` now requires an explicit non-submission assertion and reason, which is a useful guard, but the assertion itself is not independently verified. A future reconciler must query the correct cluster and prove transaction outcome before changing state or releasing capacity.

### High — idempotency does not bind the full order

The idempotency record compares only `amountLamports`. It does not bind the mint, destination wallet, slippage policy, quote identity, or transaction intent. Reusing a key with the same amount but a different order can be treated as a duplicate. Store and compare a canonical hash of the complete immutable order intent.

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

The Devnet preflight workflow added with this review checks the official Devnet genesis hash, RPC health, confirmed slot, and read-only account/supply/largest-account methods against a known Devnet reference mint. It performs **zero signing and zero transaction submissions**.

Devnet does not provide representative mainnet liquidity or a dependable market-risk dataset. DexScreener/RugCheck mainnet market results must not be presented as Devnet risk validation. A real Devnet transaction lifecycle test would require an explicitly provisioned Devnet-only test wallet and a separately reviewed transaction harness; no private key or wallet secret is included in this repository change.

## Release gate

Do not merge this PR, enable Mainnet, add a public coordinator route, or enable signing until all High findings are fixed, migrations/recovery are tested, an independent reviewer approves the complete order path, and Devnet-only signed transaction tests pass using a dedicated test wallet.
