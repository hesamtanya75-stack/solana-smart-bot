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
- Jupiter response parsing rejects malformed Base64 syntax, non-positive output, missing route data, and mismatched input/output mint or input amount.
- Execution remains intentionally unimplemented; no transaction is signed or submitted.

Eligibility values must come from trusted, fresh server-side scanner and persisted trading state. Do not accept these values from browser input. The branch now contains a SQLite-backed Durable Object coordinator with internal bearer authentication, immutable-intent idempotency, serialized reservation state, kill-switch state, per-trade and daily USD limits, open-position limits, trusted server-side SOL/USD and token-risk evidence, and bounded unsigned Jupiter transaction structure parsing. The parser validates unsigned transaction structure and can resolve v0 address lookup tables against finalized RPC state, including table ownership, activation, warmup, index bounds, and duplicate-key checks. This lookup resolution is structural evidence only: it does not semantically verify instruction programs/accounts or prove that the resolved instructions are safe. The coordinator therefore rejects every reservation until semantic instruction verification is independently implemented. Settlement transitions are also deliberately disabled until transaction submission status or cryptographic proof of non-submission can be independently established. The current Worker does not call the coordinator; no public coordinator route or live execution path is wired. The paper-trading Worker continues to use its separate paper-state Durable Object.

### Additional all-in spend accounting gate

The current $3 per-buy and $5 per-day reservation accounting converts only the SOL input amount to USD cents. It does not yet include verified maximum priority fees, base transaction fees, Jupiter submission tips, account rent/creation, or other possible SOL/token outflows. Therefore these figures are not yet an all-in spend or maximum-loss ceiling. Before any live reservation can be approved, independently decode every value-moving instruction, calculate a conservative maximum for all fees/outflows, and atomically reserve the complete all-in amount against the same daily budget. For v1, validate Jupiter's `computeUnitPrice` against an explicitly reviewed ceiling before converting it to priorityFeeLamports. Do not invent or silently default a fee ceiling.

### Verified production-evidence gap (do not confuse fixtures with live evidence)

The current `fetchTrustedLiveEvidence()` production provider returns only `quote`, `risk`, and `passed`. It does not return a `costs` object. Its Jupiter sell-route result is quote/build-envelope and transaction-structure evidence only; it does not set `semanticInstructionVerification: true` or `routeVerification: "semantically-verified"`. Consequently, the production provider cannot satisfy the coordinator's semantic-verification and all-in-cost reservation gates. Unit-test fixtures that include these fields are synthetic test inputs, not evidence that production analysis has implemented either capability. Keep reservations blocked until independently validated production evidence is implemented and tested end to end.

The current PR adds regression coverage that removes either semantic route attestation or all-in cost evidence from otherwise passing synthetic evidence and asserts that reservation is rejected without changing open-position or daily-spend state. These tests prove the coordinator's fail-closed behavior only; they do not prove the production provider can generate trusted semantic or cost evidence.

## Mandatory remaining release gates

1. Complete independent semantic verification of Jupiter instruction programs/accounts and resolve every address lookup table; the current parser validates wire structure only.
2. Establish quote freshness and validate all relevant amounts, fees, and token programs.
3. Complete and independently test the existing Durable Object coordinator's durable idempotency and settlement state machine, including restart recovery and duplicate Cron/request behavior.
4. Wire an authenticated emergency stop into the same strongly coordinated component and prove that it blocks new reservations immediately; define safe exit behavior.
5. Test RPC outages, provider errors, ambiguous submissions, partial confirmations, and restart recovery.
6. Complete a Devnet-only signing/submission test using a disposable wallet and tiny test amount.
7. Obtain independent review of signing and transaction-decoding code.
8. Have the user review final limits and explicitly approve before any Mainnet enablement.

## Not implemented here

No live signer, private-key handling, Jupiter/DEX swap execution, Mainnet transaction submission, or automatic real-money trading is implemented by this branch. Do not add a wallet secret or deposit funds based on this preparation branch.


### Explicit priority-fee ceiling configuration

The coordinator requires `LIVE_MAX_PRIORITY_FEE_LAMPORTS` to be explicitly configured as a non-negative safe integer and rejects any computed priority fee above it. There is intentionally no default value and no production ceiling is selected by this repository change. Until an operator reviews the fee policy and configures this value, reservation attempts fail closed. A test-only fixture value is used solely for unit tests and must not be copied as an operational recommendation. This setting alone does not make fee evidence trustworthy: instruction semantics and all-in outflow decoding remain mandatory blockers.

## Semantic transaction verification implementation contract (design gate)

The semantic verifier must operate on the exact unsigned message bytes that will later be signed. It must not infer safety from the Jupiter response envelope, route labels, quote metadata, or successful address-lookup-table resolution.

### Required decoding sequence

1. Parse the message format and reject unsupported versions or malformed/non-canonical encodings.
2. Resolve every static and v0 lookup-table account to an address, preserving runtime account ordering and writable/read-only privileges. Reject missing, stale, deactivated, out-of-range, duplicated, or otherwise unverifiable lookup data.
3. Resolve every compiled instruction's program ID and ordered account list against the complete key list. Validate signer and writable privileges from the message header and lookup metadata.
4. Decode every instruction's program-specific data using a pinned, reviewed decoder/version. Unknown program IDs, discriminators, malformed data, and unrecognized instruction variants must reject the entire transaction.
5. Enforce a narrow v1 allowlist. Explicitly classify Compute Budget, System Program, SPL Token, Token-2022, Associated Token Account, and the exact Jupiter router/programs intended for the supported route. Do not allow a program merely because Jupiter labels it as a swap.
6. Bind the decoded swap to immutable intent: exact input mint, output mint, input amount, minimum output, destination/owner, slippage bound, and expected token program. Any mismatch rejects.
7. Account for every possible value movement: SOL transfers, token transfers, wrapped-SOL operations, account creation/closure, rent deposits/refunds, tips, priority fees, and any other lamport/token movement. Compute conservative maximum outflow and reserve it atomically against per-trade and daily budgets.
8. Inspect all instructions that can be proven before signing. After a Devnet execution, independently inspect transaction metadata including inner CPI instructions and final balance deltas; a pre-sign decoder alone cannot prove arbitrary downstream CPI behavior.

### Fail-closed instruction policy

- Compute Budget: accept only reviewed variants; calculate priority fee from decoded compute-unit price and limit, enforce the explicitly configured ceiling, and reject duplicate or conflicting settings.
- System Program: reject arbitrary transfers, account assignments, nonce operations, and account creation unless each exact operation, destination, owner, size, and maximum lamport amount is explicitly required by immutable swap intent.
- SPL Token / Token-2022: decode exact variants and account roles; reject authority changes, delegates, permanent delegates, unexpected mint/burn, freeze/thaw, close-account destinations, and unreviewed Token-2022 extensions.
- Associated Token Account: allow only deterministic creation for the intended owner, mint, and token program; include rent in all-in cost.
- Jupiter and downstream programs: pin program IDs and reviewed instruction layouts; validate every account role and writable/signer privilege. If the route uses an unsupported CPI path or opaque instruction, reject it.
- Any other program or instruction: reject by default.

### Required adversarial test matrix

- Unknown program ID, unknown discriminator, malformed/truncated data, invalid account index, unexpected writable account, and unexpected signer.
- Wrong input/output mint, altered input amount, insufficient minimum output, wrong token owner/destination, and slippage above policy.
- Unexpected System Program transfer, rent payer/destination mismatch, account close to an attacker-controlled destination, token authority change, delegate approval, mint/burn, and Token-2022 extension bypass.
- Priority fee above cap, duplicate Compute Budget instructions, conflicting compute-unit limits/prices, hidden tip, and unaccounted SOL/token outflow.
- v0 lookup-table address substitution, wrong writable/read-only classification, missing lookup data, and an address resolved from an unfinalized or invalid table.
- A route whose outer Jupiter instruction invokes an unexpected CPI program; missing or incomplete inner-instruction metadata after execution must not be treated as proof of safety.
- Fuzz/property tests for binary decoders and mutation tests that alter one byte, account index, signer bit, writable bit, or amount at a time.

### Acceptance criteria

The verifier may report `semantically-verified` only when every instruction and referenced account is decoded, classified, bound to intent, and cost-accounted. The current unsigned parser and ALT resolver do not meet this contract. Until implementation and independent review are complete, the coordinator must continue rejecting reservations and `executeLiveOrder()` must remain unimplemented.


### Settlement proof scope: token deltas are not all-in cost proof

The current `verifyFinalizedJupiterSettlement()` checks that the exact signature is successfully finalized, the pinned bot wallet is the fee payer, and the owner-scoped input and output token balance deltas match the reserved amounts. It returns a settlement proof containing those swap facts only.

This verifier does **not** independently reconcile the bot wallet's native SOL lamport balance delta, prove the actual priority fee, identify every rent payment or tip, or establish the complete transaction outflow. In particular, wrapped SOL token-account deltas are not the same as the wallet's native SOL balance delta. The RPC transaction metadata exposes a fee field, but merely checking that the field is a non-negative integer does not make it a complete, policy-bound cost attestation.

Therefore:
- A successful settlement proof must never be interpreted as all-in spend verification.
- Do not release, replenish, or close daily spend reservations using token deltas alone.
- Keep actual fee, rent, tip, and every other native/token outflow accounting as a separate required verifier, bound to the same finalized transaction and immutable order intent.
- Reject settlement reconciliation as incomplete for budget/accounting purposes whenever the complete outflow evidence is missing, inconsistent, or exceeds the reserved all-in ceiling.

This is a documentation clarification of the current verifier's scope; it does not add a live transaction path or claim that native SOL cost reconciliation is implemented.


### Worker integration boundary

The Wrangler configuration declares a `LIVE_TRADE_COORDINATOR` Durable Object binding, but the current public `worker.js` does not reference that binding, instantiate a coordinator stub, expose live-order routes, or call `executeLiveOrder()`. The coordinator module's existence and a Wrangler binding declaration are not an operational trading path.

Keep this distinction explicit during review:
- A declared Durable Object binding is deployment configuration, not proof of application integration.
- Do not expose reservation or execution endpoints until authentication, immutable order-intent binding, semantic instruction verification, complete all-in cost verification, idempotent settlement, and independent review are all in place.
- The production Worker must continue serving no live-trading route while any of those gates are incomplete.


### Required binding for any future cost attestation

A numeric `costs` object passing coordinator arithmetic checks is not, by itself, trusted transaction evidence. Before a production provider may supply it, the cost verifier must bind its result to all of the following:

- The exact finalized transaction signature and slot, plus the resolved message/account-key set (including address-lookup-table loaded addresses).
- The immutable reservation/order-intent fingerprint, fee payer, input/output mints, token programs, and destination wallet.
- Decoded outer **and** inner instructions, including System Program transfers/account creation, token-account creation/closure, wrapped-SOL setup/cleanup, tips, and every supported CPI path.
- Actual network fee from finalized transaction metadata, with the priority-fee component reconciled against the decoded Compute Budget settings and runtime-consistent calculation; do not count the same fee twice.
- Gross outgoing lamports and token amounts attributable to the bot, with rent deposits and account-close refunds accounted for separately. A net wallet balance delta is only a reconciliation signal: refunds or incoming transfers can conceal gross outflows.
- Explicit treatment of missing metadata, unsupported versioned-message details, unresolved lookup tables, unknown CPI, and ambiguous ownership. Any incomplete or inconsistent evidence must fail closed.

The coordinator's current arithmetic validator checks the shape and internal consistency of supplied numbers; it does not establish any of these provenance or transaction-decoding facts. The production provider currently supplies no cost object, so this requirement remains an unimplemented release gate.
