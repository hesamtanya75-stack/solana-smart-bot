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
- `live-trading.mjs` requires a valid connected Phantom public key as `takerWallet` and sends it as Jupiter's taker; it does not pin the user's wallet to the server-side bot address. The returned evidence still sets `semanticInstructionVerification: false` and `routeVerification: unsigned-structure-and-alt-only`, so the unsigned transaction is not safe to sign.
- executeLiveOrder() deliberately throws that live execution is not implemented. The coordinator independently requires semantic verification and finalized settlement proof; its failure/close proofs are also intentionally unavailable.
- Therefore the existing Phantom balance display cannot currently initiate a manual trade, and changing the taker parameter alone would be unsafe: the transaction validator, coordinator ownership model, fee accounting, Worker authentication/route, browser confirmation, and settlement proof all need to be redesigned and tested together.

These findings are why this branch keeps the real-trading path disabled. The next implementation slice must first introduce wallet-bound transaction-intent verification with a complete, reviewed supported-instruction allowlist; it must not expose a signable transaction or a signing button while semantic verification remains false.

## Jupiter Swap V2 integration decisions (documentation checked 2026-11-15)

The current official Jupiter V2 documentation establishes these integration constraints:

- The manual wallet flow must call `GET /swap/v2/order` with the connected Phantom address in `taker`. A quote-only request without `taker` does not provide a transaction.
- The matching `requestId` returned by `/order` is required by `POST /swap/v2/execute`. The execution endpoint is for signed `/order` transactions; it is not the execution endpoint for `/build`.
- Read and validate the returned `transactionVersion`; V2 can return v0 or v1. Do not infer the message version from a request parameter or trust provider metadata over the deserialized message.
- The current implementation explicitly excludes JupiterZ and accepts only a returned Metis route. Keep that restriction until a separate signer/partial-signature design is reviewed: JupiterZ routes can require an additional market-maker signature.
- The /execute response's aggregate input/output fields include applicable swap fees; route-result fields do not necessarily equal the wallet's final token deltas. Final settlement must still be checked independently against finalized chain state and the Phantom owner's balances.
- Jupiter's managed landing and requestId matching do not replace our independent pre-sign semantic verification, all-in outflow ceiling, or owner-scoped settlement proof.

## CI evidence snapshot (2026-11-15)

Commit `f097be88dadac47eedc7a41970aad9d2ae54e55a` completed these GitHub Actions checks:

- Node tests: success.
- Cloudflare Worker build validation: success. This is a build-only check; it does not deploy.
- Devnet read-only cluster/RPC validation: success.
- Faucet-funded Devnet signing and transfer step: skipped because a dedicated funded Devnet RPC was not available.

The Devnet workflow's overall success therefore proves read-only connectivity and unit/runtime tests only. It does not prove Phantom signing, transaction submission, confirmation, or finalized settlement. Do not treat the skipped step as a successful signed lifecycle test.

The combined commit status also reports a failure for the legacy Deno Deploy status context `deploy/hesamtanya75-stack/solana-smart-bot-17`; that legacy status is separate from the successful Cloudflare build validation and is not evidence of a Cloudflare deployment.

## Next implementation slice — blocked until evidence is available

1. Build a wallet-bound transaction-intent model from the requested mints, exact input amount, expected minimum output, taker, allowed router, and fee limits.
2. Establish a versioned, reviewed instruction allowlist for every supported top-level program and every possible CPI route. Pin source/IDL provenance and program deployment identity; invalidate approval when any trusted program or lookup-table state changes.
3. Decode all compiled instructions and loaded lookup-table addresses and compare the resulting effects against the immutable intent. Unknown or ambiguous effects must reject the order.
4. Add adversarial fixtures and property tests before wiring any signable transaction to the browser.
5. Only after independent review, connect Phantom `signTransaction` to the exact verified bytes and Jupiter `/execute`; then prove finalized settlement on Devnet with a disposable wallet.

No signing prompt, execute route, automatic trading, Mainnet transaction, merge, or production deployment is authorized by this design update.
