# Manual Phantom live-trading implementation gate

Status: design contract only. This document does not enable signing, transaction submission, Mainnet trading, or deployment.

## Required ownership model

- The user's connected Phantom public key is the only taker, fee payer, token-account owner, and settlement owner for a manual trade.
- Remove the pinned server-side bot wallet from the user-facing manual flow. Never accept a wallet address from an untrusted request as proof of wallet ownership; bind it to the active Phantom connection and signed transaction.
- Never request, transmit, persist, or log a seed phrase or private key. The browser asks Phantom to sign; the user reviews and approves every transaction.

## Manual buy lifecycle (must remain disabled until every gate passes)

1. Read the connected Phantom public key and live SOL balance from Solana RPC.
2. Validate the mint, exact SOL input in lamports, slippage ceiling, and explicit all-in fee ceiling. Reject malformed values and values outside reviewed limits.
3. Request a fresh Jupiter Swap V2 order using the connected public key as `taker`; do not use the existing pinned bot-wallet order path.
4. Independently verify the unsigned transaction before showing a signing prompt:
   - verify the trusted Jupiter program identity and deployment/upgrade provenance;
   - decode every top-level instruction and account meta, including compute budget, system, token, associated-token, setup, cleanup, tip, and all value-moving instructions;
   - constrain downstream CPI targets and arguments to the returned immutable route intent;
   - verify input/output mints, raw amounts, token-account authorities, destination, fee recipients, and all maximum outflows;
   - resolve and verify every Address Lookup Table against trusted on-chain state and invalidate stale/changed program or ALT evidence;
   - reject unknown programs, instruction variants, account flags, extra signers, unexpected writable accounts, and any semantic ambiguity.
5. Present a human-readable confirmation: wallet, input amount, token mint, minimum output, slippage, price impact, every fee, and maximum total SOL outflow.
6. Ask Phantom to sign the exact verified transaction. Never sign a modified or re-fetched transaction.
7. Submit the signed transaction through the documented Jupiter execution lifecycle with the matching request identifier, or a separately reviewed Solana RPC submission path. Never send unsigned transactions to a server for custody.
8. Verify finalized on-chain signature and exact owner-scoped SOL/token balance deltas before marking the trade complete.
9. On timeout or ambiguous submission, do not blindly retry or release capacity. Reconcile signature and chain state first.

## Required tests

- Positive fixtures for each explicitly supported instruction and transaction version.
- Negative fixtures for every unknown program, altered discriminator/argument, account-meta mutation, unexpected signer, wrong wallet, wrong mint/amount/destination, excess fee/tip/rent, invalid lookup table, stale blockhash, and malformed serialized transaction.
- Browser tests proving the only signing call is Phantom's `signTransaction`, that the exact verified bytes are signed, and that no seed/private key is accessed.
- Worker tests proving quote/order/execute routes are authenticated, bounded, idempotent, and cannot be called by browser-controlled coordinator credentials.
- Settlement tests proving finality and exact wallet-owned input/output deltas.

## Explicitly out of scope for this stage

- Automatic buys, automatic sells, and unattended signing.
- Mainnet execution, production merge, or production deployment.
- Any weakening of existing fail-closed semantic-verification, fee, kill-switch, or settlement gates.

A manual buy must not be enabled until all implementation and test gates above are independently reviewed and pass.

## Verified repository audit (2026-11-15)

The following are code-level findings from this branch, not assumptions about the deployed site:

- index.html contains a Phantom connection and SOL-balance display, but its status text explicitly says it is not connected to the buy-request flow. The browser code uses connect and read-only getBalance; there is no signTransaction or signAndSendTransaction call in that wallet panel.
- worker.js exposes POST /api/live/quote-preview only. It intentionally omits a taker, expects a quote-only response with transaction === null, and does not return an unsigned transaction. No Worker route calls the live-trade coordinator.
- live-trading.mjs requires BOT_WALLET_PUBLIC_KEY to equal the pinned EXPECTED_BOT_WALLET, then sends that address as Jupiter's taker. Its returned evidence sets semanticInstructionVerification: false and routeVerification: unsigned-structure-and-alt-only.
- executeLiveOrder() deliberately throws that live execution is not implemented. The coordinator independently requires semantic verification and finalized settlement proof; its failure/close proofs are also intentionally unavailable.
- Therefore the existing Phantom balance display cannot currently initiate a manual trade, and changing the taker parameter alone would be unsafe: the transaction validator, coordinator ownership model, fee accounting, Worker authentication/route, browser confirmation, and settlement proof all need to be redesigned and tested together.

These findings are why this branch keeps the real-trading path disabled. The next implementation slice must first introduce wallet-bound transaction-intent verification with a complete, reviewed supported-instruction allowlist; it must not expose a signable transaction or a signing button while semantic verification remains false.
