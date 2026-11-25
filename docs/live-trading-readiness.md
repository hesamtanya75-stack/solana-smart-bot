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
