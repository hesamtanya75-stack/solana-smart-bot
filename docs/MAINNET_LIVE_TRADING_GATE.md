# Mainnet live-trading implementation gate

## Current status

This repository currently implements paper trading only. The scheduled Worker updates simulated positions and simulated balance. It does not construct, sign, or submit Solana transactions.

This branch is preparation only. It does not enable live trading and must not be deployed as a live trader.

## Required architecture

1. Keep the existing paper-trading engine unchanged.
2. Add a separate live-trading module with an explicit, default-off feature flag.
3. Use a dedicated bot wallet only. The personal wallet must never be used as the server signer.
4. Keep signing material out of GitHub, browser code, KV state, logs, error messages, and chat.
5. Before selecting a signer, verify the exact Solana transaction format, key custody model, and Cloudflare Workers compatibility. Do not accept a private key through an HTTP request.
6. Quote and swap through a supported Solana swap provider, validate the returned transaction and all account/program destinations, then sign and submit only after every policy check passes.
7. Verify confirmed transaction status and reconcile actual token/SOL balances from RPC. Never treat a quote or successful HTTP response as a completed trade.

## Mandatory fail-closed controls

- `LIVE_TRADING_ENABLED` defaults to `false`; missing or malformed configuration means disabled.
- Dedicated wallet public key must exactly match the configured expected public key.
- Maximum per-trade spend, maximum daily spend, maximum open positions, maximum slippage, minimum liquidity, and minimum 24-hour volume must all be explicit finite limits.
- Enforce the existing token-risk checks plus an independent allow/deny policy for mint/freeze authority, Token-2022 extensions, holder concentration, liquidity, and sell route availability.
- Reject stale quotes, unexpected mints, unexpected token programs, unexpected swap programs, and transactions whose decoded instructions do not match the approved swap.
- Use idempotency keys and durable pending/confirmed/failed states to prevent duplicate submissions during Cron retries.
- Add an authenticated emergency stop that blocks new buys immediately and supports safe position exit policy.
- Never automatically retry a transaction if its submission/confirmation state is ambiguous; reconcile the signature first.
- Do not log secrets, raw signed transactions, or sensitive wallet material.

## Test and release gates

1. Unit tests for all risk and spend-limit decisions.
2. Test quote parsing and transaction instruction allow-listing with mocked responses.
3. Devnet-only signing/submission test using a disposable wallet and tiny test amount.
4. Verify duplicate Cron invocations cannot create duplicate swaps.
5. Verify emergency stop, RPC outages, provider errors, and partial confirmations fail closed.
6. Independent review of the signing and transaction-decoding code.
7. User review of the final limits and explicit approval before any Mainnet enablement.

## Not implemented here

No live signer, private-key handling, Jupiter/DEX swap execution, Mainnet transaction submission, or automatic real-money trading is implemented by this document. Do not add a wallet secret or deposit funds based on this preparation branch.
