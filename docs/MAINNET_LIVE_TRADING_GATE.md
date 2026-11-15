# Mainnet live-trading implementation gate

## Current status

This repository currently implements paper trading only. The scheduled Worker updates simulated positions and simulated balance. It does not construct, sign, or submit Solana transactions.

This branch is preparation and policy enforcement only. It does not enable live trading and must not be deployed as a live trader.

## Required architecture

1. Keep the existing paper-trading engine unchanged.
2. Keep the live-trading module separate and default-off.
3. Use the user's connected Phantom wallet as the transaction fee payer and signer, with the wallet public key explicitly bound to the approved trade intent and finalized settlement owner. The server must never act as that wallet's signer.
4. Keep seed phrases and private keys out of GitHub, browser code, server environment, KV state, logs, error messages, and chat. Only the Phantom extension may access and use its own signing capability.
5. Before requesting Phantom approval, independently verify the exact Solana transaction message, signer, input/output mints, spend amount, recipient/token accounts, every invoked program, every writable account, lookup-table resolution, and all fee/tip/rent outflows. Reject unknown instruction types and unsupported transaction versions.
6. Quote and build through a supported Solana swap provider, validate the complete returned transaction against the approved Phantom public key and immutable trade intent, then request explicit Phantom signing only after every policy check passes.
7. Submit only the Phantom-signed transaction, then verify finalized transaction status and reconcile actual token/SOL balances from RPC. Never treat a quote or successful HTTP response as a completed trade.

## User-requested initial trade cap (not yet operational)

The user selected a maximum of **USD $3 per buy**, a maximum cumulative spend of **USD $5 per day**, and a maximum of **10 simultaneous open positions**. These are requested limits only; they are not active, deployed, or enforced by the current Worker. The daily cap must be enforced atomically across concurrent requests and Cron retries. Before implementation, the server must convert the USD cap to lamports using a trusted, fresh SOL/USD price with conservative rounding, and reject the trade if the price is unavailable or stale. Slippage, liquidity/volume thresholds, and other risk controls still require explicit review. Do not infer or enable those settings from the user's selected position count.

## Implemented fail-closed policy checks in this branch

- LIVE_TRADING_ENABLED must be exactly true; missing or malformed configuration disables live trading.
- LIVE_TRADING_KILL_SWITCH must be exactly false; otherwise live trading is disabled.
- Jupiter order construction now requires an explicit connected Phantom public key and passes it as the `taker`; the unsigned transaction parser checks that this key is the required fee payer/signer. This is order preparation only: no browser Phantom signing or transaction submission is wired.
- Per-trade spend, daily spend, open-position count, maximum slippage, minimum liquidity, and minimum 24-hour volume must be explicit bounded values.
- evaluateLiveTradeEligibility enforces the per-trade cap, cumulative daily spend cap, open-position cap, minimum liquidity, minimum volume, and explicit passing results for mint authority, freeze authority, Token-2022 extension safety, holder concentration, and sell-route availability.
- getJupiterOrder requires eligibility data and rejects a trade before network access if any check is missing or fails.
- Jupiter response parsing rejects malformed Base64 syntax, non-positive output, missing route data, and mismatched input/output mint or input amount.
- Execution remains intentionally unimplemented; no transaction is signed or submitted.

Eligibility values must come from trusted, fresh server-side scanner and persisted trading state. Do not accept these values from browser input. The branch now contains a SQLite-backed Durable Object coordinator with internal bearer authentication, immutable-intent idempotency, serialized reservation state, kill-switch state, per-trade and daily USD limits, open-position limits, trusted server-side SOL/USD and token-risk evidence, and bounded unsigned Jupiter transaction structure parsing. The parser preserves compiled instruction bytes and account indexes and resolves v0 address lookup tables, but deliberately does not semantically verify instruction programs/accounts. The trusted-evidence module now also checks that the exact outer-instruction program set is fully covered by finalized program identity evidence and matches the narrowly code-reviewed native or upgradeable deployment identity policies; it rejects missing, unexpected, duplicate, or unsupported-loader programs. This remains deployment-identity evidence only and explicitly returns `semanticInstructionVerification: false`; it does not decode instruction data, validate account roles, or prove CPI behavior. The coordinator therefore rejects every reservation until semantic instruction and lookup-table verification is independently implemented. Settlement transitions are also deliberately disabled until transaction submission status or cryptographic proof of non-submission can be independently established. The current Worker does not call the coordinator; no public coordinator route or live execution path is wired. The paper-trading Worker continues to use its separate paper-state Durable Object.

### Additional all-in spend accounting gate

The isolated coordinator now has a fail-closed all-in cost-evidence validator: it requires explicit compute-unit price/limit, maximum priority fee, base fee, tip, rent, and other-outflow fields; checks priority-fee arithmetic against a configured cap; sums all components with the SOL input; and applies the per-trade/daily limits to that total. However, no trusted transaction analyzer currently produces and proves every one of those fields from a semantically decoded transaction, and the current Worker is not wired to the coordinator. Thus this validator is only a downstream accounting gate, not evidence that the live transaction's complete outflows are known or capped. Before live use, independently decode every value-moving instruction, derive conservative fee/rent/tip/outflow bounds from that exact transaction, and bind those results to the reviewed order. For v1, validate Jupiter's `computeUnitPrice` against an explicitly reviewed ceiling before converting it to priorityFeeLamports. Do not invent or silently default a fee ceiling.

## Mandatory remaining release gates

1. Complete independent semantic verification of Jupiter instruction programs/accounts, writable/signer roles, and all value-moving instructions. Exact outer-program deployment identity coverage is now checked. A narrowly scoped decoder now recognizes only native System Program `Transfer` instructions and validates the source signer/writable role, destination writable role, distinct accounts, canonical data, and positive lamport amount; every other System Program instruction is rejected. This decoder is not wired as a whole-transaction approval gate. A separate narrow decoder now recognizes only classic SPL Token `Transfer` and `TransferChecked` instructions, validates source/destination writable roles, a signer authority, mint role for checked transfers, canonical instruction bytes, exact account counts, and positive token amounts. Multisig authorities, Token-2022, and all other token opcodes remain unsupported and rejected. Neither decoder is wired as a whole-transaction approval gate. v0 lookup-table contents and all other instruction semantics remain untrusted.
2. Establish quote freshness and validate all relevant amounts, fees, and token programs.
3. Complete and independently test the existing Durable Object coordinator's durable idempotency and settlement state machine, including restart recovery and duplicate Cron/request behavior.
4. Wire an authenticated emergency stop into the same strongly coordinated component and prove that it blocks new reservations immediately; define safe exit behavior.
5. Test RPC outages, provider errors, ambiguous submissions, partial confirmations, and restart recovery.
6. Refactor order construction and settlement binding to the connected Phantom public key, then complete a Devnet-only Phantom signing/submission test using a disposable wallet and tiny test amount.
7. Obtain independent review of signing and transaction-decoding code.
8. Have the user review final limits and explicitly approve before any Mainnet enablement.

## Not implemented here

No live signer, private-key handling, Jupiter/DEX swap execution, Mainnet transaction submission, or automatic real-money trading is implemented by this branch. Do not add a wallet secret or deposit funds based on this preparation branch.


### Explicit priority-fee ceiling configuration

The coordinator requires `LIVE_MAX_PRIORITY_FEE_LAMPORTS` to be explicitly configured as a non-negative safe integer and rejects any computed priority fee above it. There is intentionally no default value and no production ceiling is selected by this repository change. Until an operator reviews the fee policy and configures this value, reservation attempts fail closed. A test-only fixture value is used solely for unit tests and must not be copied as an operational recommendation. This setting alone does not make fee evidence trustworthy: instruction semantics and all-in outflow decoding remain mandatory blockers.
