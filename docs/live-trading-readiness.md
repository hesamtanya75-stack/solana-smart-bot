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

The current helper accepts SOL-denominated amounts as JavaScript numbers and compares quote input amounts using a floating-point tolerance. This is suitable only for the present validation fixture; it is not an execution-grade amount representation. A future live path must use integer lamports for SOL and integer atomic units for tokens, with explicit mint decimals and checked conversions. It must not use floating-point values as the authoritative amount for transaction construction, daily accounting, or fee enforcement.

The Base58 mint check currently verifies only a plausible character set and string length. It does not decode the address to confirm exactly 32 bytes, prove that the account exists, or verify its on-chain owner and token-program type. Those checks must be performed against trusted chain data before any live order is authorized.
