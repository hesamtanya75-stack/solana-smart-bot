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
- Jupiter response shape is checked, but no transaction is accepted or returned: the module now fails closed until a real Solana message decoder resolves address lookup tables and validates every instruction/program/account against an explicit reviewed allow-list. Base64 syntax alone is never treated as transaction validation.
- Execution remains intentionally unimplemented; no transaction is signed or submitted.

Eligibility values must come from trusted, fresh server-side scanner and persisted trading state. Do not accept these values from browser input. This branch does not yet provide the instruction decoder, quote-freshness proof, durable idempotency, signing, submission, confirmation reconciliation, or emergency-stop endpoint. The current Worker uses Cloudflare KV for application state; KV is eventually consistent and does not provide the atomic transaction/compare-and-set guarantees needed to enforce concurrent daily spend limits or prevent duplicate live submissions. A live execution design must use a serialized coordinator such as a Cloudflare Durable Object (or another transactional store) for per-wallet spend accounting, idempotency keys, kill-switch state, and pending/confirmed/failed transitions. The policy helper in this branch is not wired to trusted scanner data or the Worker and must not be treated as an operational trade gate.

## Mandatory remaining release gates

1. Implement and independently audit transaction message decoding, address lookup table resolution, and program/account allow-listing. Until this is complete, `getJupiterOrder` deliberately rejects every otherwise-shaped Jupiter order.
2. Establish quote freshness and validate all relevant amounts, fees, and token programs.
3. Move live execution coordination out of KV-only state into a serialized/transactional component (for example, a Cloudflare Durable Object); implement durable idempotency keys and pending/confirmed/failed states to prevent duplicate submissions during Cron retries.
4. Add an authenticated emergency stop stored in the same strongly coordinated component so it blocks new buys immediately; define safe exit behavior.
5. Test RPC outages, provider errors, ambiguous submissions, partial confirmations, and restart recovery.
6. Complete a Devnet-only signing/submission test using a disposable wallet and tiny test amount.
7. Obtain independent review of signing and transaction-decoding code.
8. Have the user review final limits and explicitly approve before any Mainnet enablement.

## Not implemented here

No live signer, private-key handling, Jupiter/DEX swap execution, Mainnet transaction submission, or automatic real-money trading is implemented by this branch. Do not add a wallet secret or deposit funds based on this preparation branch.
