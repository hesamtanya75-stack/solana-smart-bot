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


## CPI and transaction-introspection boundary (reviewed 2026-11-15)

Solana's official transaction model confirms that a compiled instruction contains a program ID, ordered account metas, and opaque instruction data. A transaction decoder can recover those outer instructions, but the bytes alone do not reveal every downstream program invocation: CPI targets are selected during program execution.

- The official Solana transaction-introspection guide explains that versioned messages use static keys plus loaded ALT addresses, while CPI instructions are supplied separately in transaction metadata as `innerInstructions`. The helper's `walkInstructions` combines outer instructions and recorded inner instructions.
- The official RPC JSON-structures guide documents `meta.innerInstructions` as execution metadata. It is not part of the unsigned message the wallet is asked to sign.
- Therefore, resolving every static key and ALT is necessary but not sufficient for pre-sign approval. A read-only helper fetches finalized account snapshots for referenced program IDs and records each account's owner, executable bit, data size, and a classification against the four recognized Solana loader owners (legacy BPF, BPF v2, upgradeable BPF, and native loader). Unknown executable-account owners are rejected. This is still only a loader-ownership classification: it does not parse the upgradeable Program/ProgramData relationship, establish upgrade authority or immutability, hash deployed ELF bytes, or prove CPI behavior. A local decoder must not claim it has proven CPI behavior merely because all top-level program IDs are known.
- A simulation can provide useful execution evidence for the current state, but it is not a durable proof that a state-dependent program will invoke only the same CPIs when the signed transaction lands. Treat simulation as an additional rejection gate, never as a replacement for reviewed program semantics and deployment identity.
- Any supported router/program must have a reviewed, versioned policy describing its possible CPI targets, argument constraints, writable-account effects, signer privilege propagation, and upgrade authority/deployment identity. If that cannot be established, reject that route and keep semantic verification false.
- The program identity snapshot is deliberately not wired to a signing path and always returns `semanticInstructionVerification: false`. It rejects missing/non-executable accounts, malformed owner/data fields, mismatched account data sizes, invalid RPC context, and excessive/invalid program lists.
- Add fixtures with nested CPI traces, missing or incomplete inner-instruction metadata, unexpected CPI programs, altered account privileges, and state-dependent route changes. Missing trace evidence must never be interpreted as an empty CPI list.

Official references:
- https://solana.com/docs/core/transactions
- https://solana.com/docs/core/instructions/instruction-structure
- https://solana.com/docs/rpc/json-structures
- https://solana.com/docs/core/cpi
- https://solana.com/docs/core/transactions/versioned-transactions
- https://solana.com/docs/core/transaction-introspection

## CI evidence snapshot (2026-11-15, refreshed)

Latest reviewed PR head: `879c3752c031ae43974049997170acc2bc6d1be6`.

- Node tests and isolated Durable Objects runtime: 236 passed, 0 failed (run `43753666397`, job `132932957148`).
- Cloudflare Worker build validation: success (run `43753666419`, job `132932957650`; build validation only, no deployment).
- Devnet cluster identity and read-only RPC validation: success (run `43753666403`, job `132932957143`).
- Faucet-funded Devnet signing and transfer step: explicitly skipped because `DEVNET_RPC_URL` is not configured.
- The Devnet workflow reports success because its explicit skip-report step succeeds; this does not prove a signed transfer, token swap, or settlement. No signing or transaction submission was attempted.
- The earlier run on parent head `ab7eae678473a3128c0a7c159eb8cdd506bf8f8b` also passed Node, Cloudflare build, and read-only Devnet checks, with the funded transfer skipped.
- The combined status may still include the legacy Deno Deploy context failure; this is separate from the Cloudflare Worker build and is not a Worker deployment result.

No signing prompt, execute route, automatic trading, Mainnet transaction, merge, or production deployment is authorized by this documentation update.

## Program loader ownership and deployment evidence (2026-11-15)

- Finalized executable program-account snapshots reject owner IDs outside the recognized Solana loader-owner set: legacy BPF loader, BPF loader v2, upgradeable BPF loader, and native loader.
- For upgradeable BPF programs, the evidence reader parses the Program account's state tag and ProgramData address, then fetches Program accounts again alongside ProgramData at finalized commitment. A changed ProgramData pointer is rejected.
- The identity snapshot accepts at most 50 distinct program IDs, keeping the refreshed Program plus unique ProgramData account request within the Solana RPC 100-account batch ceiling; oversized sets fail before RPC.
- ProgramData parsing validates its state tag, deployment slot, authority option encoding, account owner, canonical base64, account-size metadata, and Solana SBF ELF64 identification/header fields (little-endian EM_BPF). It reports the upgrade authority (or immutable state) and SHA-256 of the deployed ELF payload, excluding the loader header.
- The second RPC read binds the ProgramData account to a refreshed Program pointer snapshot; it is still read-only provenance evidence and is not a transaction-wide atomic guarantee across separate RPC calls.
- Other recognized loader types remain classified by owner only; this does not parse their executable formats.
- A code hash and upgrade-authority value do not establish semantic safety. They must be compared against a separately reviewed, versioned allowlist and policy. Unknown or changed deployments must fail closed.
- `semanticInstructionVerification` remains `false`; no signing or execution path consumes this evidence. Adversarial coverage must include missing ProgramData, wrong owner/state tag, malformed authority option, truncated headers, changed ProgramData pointer, malformed/oversized account data, and altered deployed code hashes.


## SBF ELF deployment-header hardening (2026-11-15)

- The upgradeable ProgramData provenance parser now requires ELF64 little-endian shared-object type (ET_DYN), SBF machine type (EM_BPF), ELF version 1, and a 64-byte ELF header before hashing deployed code.
- Regression fixtures explicitly encode ET_DYN and reject an otherwise ELF-shaped payload with a different ELF object type.
- This is a format-integrity check only. It does not prove the deployed program's instruction semantics or CPI behavior; the reviewed program/version/hash allowlist and semantic verifier remain outstanding.


## Reviewed deployment allowlist matcher (2026-11-15)

- Added `verifyUpgradeableProgramDeploymentAllowlist` as a fail-closed provenance gate for upgradeable BPF programs observed in the finalized outer-instruction evidence.
- Each code-owned allowlist entry must pin the exact program ID, loader type, deployed ELF SHA-256, upgrade authority (including immutable/null), policy ID/version, and SHA-256 of the reviewed instruction-policy document. Duplicate or malformed entries are rejected.
- The observed executable account owner must map to the expected upgradeable loader; program ID, ProgramData address, code hash, authority, and immutability fields are validated before a match is returned.
- The helper intentionally supports only upgradeable BPF deployments in this stage. It rejects other loader classes instead of pretending owner classification is equivalent to a code identity hash.
- This matcher returns `semanticInstructionVerification: false` unconditionally. It only confirms that a deployment matches a code-owned reviewed identity record. It does not decode any instruction, prove CPI effects, authorize a reservation, or enable Phantom signing.
- Never pass the allowlist from browser/request input. The remaining implementation must add actual independently reviewed program policies with real deployment hashes and exact instruction/CPI semantics, then bind decoded transaction instructions to those policies. No production program hashes or trust entries were invented or inserted by this change.

## Enabling the funded Devnet lifecycle

The read-only Devnet preflight can pass without credentials. The funded ephemeral-signing transfer remains skipped until a dedicated Devnet RPC endpoint is configured as a GitHub Actions repository secret.

1. Open the repository on GitHub: `hesamtanya75-stack/solana-smart-bot`.
2. Go to **Settings → Secrets and variables → Actions → New repository secret**.
3. Set the secret name to exactly `DEVNET_RPC_URL` and paste a dedicated Devnet RPC HTTPS endpoint as its value. Do not commit the endpoint, place it in a workflow file, or send it in chat.
4. Save the secret, then rerun the **Devnet signed lifecycle validation** workflow from the Actions tab (or push a later PR commit).
5. Confirm that the step **Verify ephemeral signing and submit a faucet-funded Devnet test transfer** completes successfully. A green overall workflow with that step marked **skipped** is only a read-only preflight pass, not proof of signing or settlement.

The lifecycle uses an ephemeral test key only for a faucet-funded Devnet transfer; it must not use a Phantom seed phrase, production wallet key, or Mainnet endpoint. The Devnet transfer test is separate from swap semantic verification and does not authorize Mainnet trading.
