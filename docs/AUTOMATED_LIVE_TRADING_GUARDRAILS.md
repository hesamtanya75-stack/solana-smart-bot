# Unattended live-trading safety architecture

## Status and scope

Design-only proposal. This document does not add a signer, live API route, automated execution, Mainnet capability, Cloudflare configuration, or dashboard changes. Paper trading remains the only executable trading mode. No wallet keys, secrets, or funds are required for this design review.

The requested product behavior is unattended buying and selling: after a separately funded trading wallet is explicitly enrolled and the policy is configured, the bot may execute buys and sells without a per-order human approval. This is fundamentally different from Phantom's browser approval flow. A connected Phantom provider cannot safely provide background signing while the user is absent. Do not attempt to bypass Phantom prompts or store a Phantom seed phrase/private key in the browser, Worker, KV, Durable Objects, logs, or source code.

## Wallet separation

- Use a dedicated, newly created trading wallet with only the amount the operator is prepared to lose. Never use the operator's primary Phantom wallet or a wallet holding long-term assets.
- The trading wallet must have no withdrawal/transfer capability exposed to the strategy. The signing service should authorize only narrowly scoped swap transactions; it must reject arbitrary SOL/token transfers, authority changes, delegate approvals, account closures, and unknown programs.
- Keep signing isolated from the public Worker and browser. A managed signer/HSM or separately hardened signing service should enforce transaction policy independently. Do not place raw private keys or seed phrases in Cloudflare Worker environment variables, Workers KV, Durable Objects, browser storage, or logs.
- Wallet enrollment and funding are separate, deliberate operator actions. The bot must never generate, request, display, or transmit a seed phrase.

## Mandatory server-side policy

All values below must be explicitly configured and validated before any live capability can be enabled; no permissive defaults:

1. Maximum spend per order, maximum cumulative daily spend, maximum total open exposure, and maximum number of open positions.
2. Maximum daily realized plus unrealized loss, with an atomic kill switch that blocks new buys and defines the configured exit behavior.
3. Minimum liquidity and 24-hour volume, maximum price impact and slippage, quote age/expiry, and minimum expected output.
4. Token mint/freeze authority checks, Token-2022 extension policy, holder concentration, verified mint identity, sell-route availability, and independent rug/risk evidence.
5. Allow/deny lists for mints and programs; reject unknown programs and unsupported instruction variants.
6. Per-wallet and per-session idempotency, replay prevention, atomic spend reservations, and strict concurrency limits.
7. Pause all trading on RPC disagreement, stale market data, quote/build mismatch, failed instruction decoding, failed settlement verification, rate-limit exhaustion, or ambiguous submission. Never blindly retry with a new transaction.

Risk checks must run server-side on every order, including sells. Client-provided price, balance, risk score, route, fee, or policy result is never authoritative.

## Transaction verification and execution

- Build an immutable, short-lived order intent bound to the trading wallet, cluster, mint pair, exact input amount, minimum output, maximum slippage, fee ceiling, expiry, and idempotency key.
- Decode the complete legacy/v0 transaction, resolve address lookup tables, and semantically verify every instruction, account, signer, writable privilege, transfer, fee, rent effect, and destination against a reviewed allowlist.
- Reject unknown or unverifiable instructions. An address/program allowlist alone is not semantic verification.
- The isolated signer independently re-evaluates policy and signs only the exact approved intent. It must not offer a general-purpose signing API.
- Submit once. If the result is ambiguous, reconcile the same signature rather than constructing a replacement transaction.
- Independently verify finalized settlement, including native SOL, WSOL, SPL/Token-2022 balances, fees, rent, tips, and all-in debit/credit, before updating positions or P&L.
- Automatic sells use explicit, tested exit rules and the same policy, decoding, signing, and settlement gates as buys. No automatic sell may bypass the kill switch or accounting controls.

## Operational controls

- A prominent emergency stop must block new orders immediately. Its behavior for existing positions must be separately configured and tested; stopping new buys must not silently imply liquidation.
- Alert on every execution, rejection, pause, daily-limit approach, loss-limit breach, signer failure, and settlement discrepancy. Keep an append-only audit trail without secrets.
- Enforce least privilege, signer rotation/revocation, strong operator authentication/MFA, origin/CSRF protection, rate limits, and separation between deployment credentials and wallet signing authority.
- Run strategy logic in paper mode first and compare simulated decisions with market conditions. Then test the exact transaction path on Devnet using a disposable funded test wallet and explicit opt-in.
- Use a staged live release with a tiny separately funded wallet, low hard caps, monitoring, and an independently reviewed rollback/disable procedure. Increase limits only through an explicit configuration change and review.

## Required acceptance gates before any Mainnet live trading

- Threat model and signer isolation reviewed independently.
- No private key or seed phrase in browser, Worker, KV, Durable Objects, logs, or repository.
- Wallet enrollment and signer authorization tests pass.
- Complete semantic instruction decoder and address lookup table verification pass positive and negative tests.
- Spend, exposure, loss, slippage, liquidity, volume, token-authority, Token-2022, holder, idempotency, replay, and concurrency tests pass.
- Buy and sell flows both have verified all-in cost and finalized settlement.
- Failure injection covers RPC outages, rate limits, stale quotes, partial/ambiguous submissions, duplicate cron invocations, signer outage, and settlement mismatch.
- Emergency stop and recovery behavior are tested.
- Devnet end-to-end tests pass with a disposable wallet and explicit opt-in.
- A separate release review explicitly authorizes Mainnet deployment and activation. Passing CI or connecting Phantom is not authorization.

## Current project boundary

The current application remains paper-trading only. The read-only Phantom connection is for displaying the public address and balance; it is not an unattended signer. The existing live execution stub deliberately does not sign or submit transactions, the live coordinator is not integrated into a Worker route, and semantic instruction verification is incomplete. Do not enable Mainnet, add signing/submission routes, deploy, merge the PR, or modify production KV/DO data as part of this design-only stage.

## Decisions required before implementation

- Choose the dedicated wallet custody/signing model and recovery/revocation process.
- Set explicit per-order, daily spend, total exposure, position-count, loss, slippage, liquidity, and volume limits.
- Define token/program allowlists and the exact automatic buy/sell strategy.
- Define whether a loss-limit breach only blocks new buys or also triggers a pre-approved exit policy.
- Approve a separate implementation plan and non-production test scope before any signer or execution code is written.
