# Phantom per-order approval architecture

## Status

Design gate only. This document does not enable live trading, add a live API route, sign a transaction, submit a transaction, or change the dashboard. The current Phantom integration remains read-only. The current Worker remains paper-trading only.

## Required user experience

Every buy and every sell is a separate order. The application must show the complete order review before asking Phantom to sign:

- Connected Phantom public key and requested fee payer.
- Buy or sell direction, input/output mint, token symbol and verified mint address.
- Exact input amount and minimum expected output after slippage.
- Maximum slippage, network/cluster, quote timestamp and expiry.
- Network fee, priority fee, platform/Jupiter fee, rent and any tip, with an all-in maximum debit.
- Every destination/program that can receive funds, including token-account creation and cleanup effects.
- Clear warning for unknown or unverifiable fields.

The user must click a dedicated confirmation control for that one order, then approve the exact transaction in Phantom. No standing approval, batch signing, auto-signing, background signing, or automatic retries that create a new transaction are allowed. A sell requires the same separate review and approval as a buy.

## Non-negotiable wallet model

The currently pinned `EXPECTED_BOT_WALLET` is incompatible with the requested personal Phantom-wallet flow. The browser-connected Phantom public key must become the transaction owner, fee payer, and settlement owner for that individual order. It must be re-read immediately before signing and compared with the owner in the server-issued intent. Any account change, disconnect, cluster change, expired quote, or changed transaction invalidates the review and requires a fresh order and fresh approval.

The Worker must never hold a wallet private key or ask for a seed phrase. Signing is permitted only by the Phantom provider in the browser, in direct response to the user's explicit action.

## Required trust boundaries and sequence

1. **Create intent (server):** authenticate the existing user session; accept only order inputs and the connected public key; independently fetch market/risk evidence; apply per-order, daily, liquidity, volume, token-authority, holder, and kill-switch policy. Do not trust client-supplied prices, risk flags, balances, fee estimates, or route claims.
2. **Build unsigned transaction (server):** request a fresh Jupiter order/build for the exact Phantom owner. Bind the response to a short-lived, single-use intent ID and immutable digest. Never return an executable order if semantic verification is incomplete.
3. **Decode and verify (server):** deserialize the complete legacy/v0 message, resolve every address lookup table at a sufficiently recent finalized context, then decode every instruction. Enforce a reviewed allowlist and exact argument/account constraints for the selected Jupiter router, System Program, SPL Token and Token-2022, Associated Token, Compute Budget, and any explicitly supported ancillary program. Reject unknown programs, unknown instruction variants, unexpected signers, writable accounts, token authorities, delegate changes, close-authority changes, arbitrary transfers, unreviewed tips, and unexpected SOL/token outflows. Check that route-plan mints/amounts agree with the decoded swap instructions. An address allowlist alone is not semantic verification.
4. **Present review (browser):** render the server-derived immutable order summary. The browser must not modify the transaction bytes. Show the exact wallet, network, amounts, minimum output, fees, and recipients. If any field cannot be decoded or explained, disable confirmation.
5. **Explicit Phantom approval (browser):** on a direct user click, verify the provider is still connected to the same public key and expected cluster, then request signing of that one exact message. Never call signing from timers, effects, cron jobs, or server code.
6. **Verify signed message (server):** receive the signed transaction only after the user has approved it. Deserialize it again; verify the message digest equals the approved immutable intent, all required signatures are valid, the expected Phantom wallet is the fee payer and sole expected signer, and all decoded instructions still pass the same semantic policy. Reject altered, expired, replayed, or partially signed transactions.
7. **Submit once (server):** only after all previous gates, submit the already user-signed bytes once. Do not rebuild, mutate, or silently re-sign. If the submission result is ambiguous, query the same signature and reconcile; do not blindly resubmit a different transaction.
8. **Independent settlement (server):** verify the exact signature reaches finalized status with no execution error. Verify transaction message, fee payer, owner-scoped pre/post token balances, native SOL deltas, rent, fees, tips, and all-in debit/credit against the approved intent. Update the position ledger only from independently verified settlement evidence. Failure/close transitions require equally strong proofs.

## Required coordinator changes before integration

- Remove the hardcoded bot-wallet assumption only as part of a reviewed migration to per-user wallet-bound intents; never simply replace the constant with a client-supplied address.
- Bind every reservation to authenticated user/session identity, Phantom wallet, cluster, input/output mint, exact input amount, minimum output, slippage, decoded instruction digest, quote/build expiry, and a cryptographically strong idempotency key.
- Ensure a reservation cannot be signed by another wallet or replayed by another user/session.
- Store only the minimum necessary audit and reservation metadata; never store private keys or seed phrases.
- Preserve kill-switch precedence and atomic spend/position accounting.
- Keep the Durable Object inaccessible to browsers; only authenticated Worker code may call it.
- Add explicit state transitions for approval, submission, and settlement with replay-safe idempotency. A pending reservation must not itself authorize submission.

## Current blockers confirmed in code

- `index.html` exposes only Phantom connect/disconnect and public SOL balance reads; it contains no signing or transaction-submission methods.
- `live-trading.mjs` retrieves an unsigned Jupiter V2 order, and `executeLiveOrder()` deliberately throws because execution is not implemented.
- `trusted-live-evidence.mjs` parses transaction structure and resolves lookup tables, but reports `semanticInstructionVerification: false`; it does not yet establish trust in the meaning of the complete instruction set.
- `live-trade-coordinator.mjs` fingerprints orders against a pinned bot wallet and settlement verification requires that same wallet. This is not the user's Phantom-wallet approval model.
- `worker.js` does not expose a live-order route or call the LiveTradeCoordinator. The Wrangler binding alone does not mean the coordinator is integrated.
- The existing settlement verifier requires owner-scoped SPL token deltas for the wrapped-SOL mint; native SOL wrapping/unwrapping and rent/fee effects need explicit transaction-aware verification before it can support general SOL routes.

## Acceptance gates

Do not enable live trading until all are true:

- A reviewed decoder exists for every permitted instruction/program and rejects everything else.
- Fuzz, malformed-message, unexpected-account, lookup-table, signer-substitution, fee/tip, token-account, and altered-message tests pass.
- Buy and sell flows both enforce one order = one explicit Phantom approval.
- Wallet change, session expiry, quote expiry, replay, duplicate requests, network mismatch, and ambiguous RPC submission are tested fail-closed.
- Signed-message verification is independent of the browser and occurs before submission.
- Finalized settlement verifies native SOL, wrapped SOL, SPL/Token-2022, fees, rent, and all-in costs.
- Cloudflare Worker route authentication, CSRF protections, rate limits, Durable Object authorization, and kill-switch behavior are reviewed.
- Devnet end-to-end tests use a dedicated test wallet and explicit opt-in. Mainnet remains disabled until a separate release review and explicit authorization.

## Explicitly out of scope for this design stage

No Phantom signing calls, no transaction submission, no Mainnet enablement, no production deployment, no PR merge, no Cloudflare secret/binding/KV/DO migration, and no dashboard redesign.
