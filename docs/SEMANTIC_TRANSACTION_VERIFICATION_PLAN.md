# Semantic transaction verification implementation plan

## Audit baseline

Reviewed against PR #40 head `e1466c33687b4a1798f01ecf3c84b21a456c1d2f`.

The current transaction parser performs structural validation and address lookup table resolution, but its own evidence deliberately returns:

- `semanticInstructionVerification: false`
- `routeVerification: "build-envelope-only"` or `"unsigned-structure-and-alt-only"`

The LiveTradeCoordinator explicitly rejects reservations unless semantic verification is true and the route status is exactly `semantically-verified`. This is the correct fail-closed behavior and must remain in place until the verifier below is independently implemented and tested.

This document is a plan only. It does not change parser behavior, coordinator gates, live routes, signing, submission, deployment, or production data.

## Required verifier output

A verifier may attest a transaction only when it has decoded and validated the complete message and all resolved account keys. Its output must be immutable and bound to:

- Exact serialized message digest and transaction version.
- Expected enrolled wallet, fee payer, signer set, and cluster.
- Recent blockhash and validity/expiry context.
- Every instruction in original order, with program ID, decoded instruction type, exact account roles/privileges, and decoded arguments.
- All address lookup tables, their finalized context, and resolved writable/readonly addresses.
- Expected input/output mints, exact input amount, minimum output, fee ceiling, tip policy, and destination accounts.
- A short-lived immutable order intent and idempotency key.

Do not derive a trusted attestation from Jupiter's route-plan JSON, an allowlisted program ID, or a client-supplied boolean alone.

## Verification stages

1. **Message integrity:** retain strict size, canonical encoding, signature-count, header, account-index, duplicate-key, and transaction-version validation. Reject malformed or unsupported message formats.
2. **Lookup tables:** resolve every referenced lookup table from a trusted RPC at finalized commitment; verify owner, metadata, deactivation/warmup state, index bounds, duplicate addresses, and complete key ordering. Fail closed on missing or inconsistent data.
3. **Program and instruction allowlist:** define a versioned allowlist of exact supported program IDs and instruction variants. Initially reject all programs and variants not explicitly covered by reviewed decoders.
4. **System Program:** decode each permitted transfer/create/allocate/assign variant and validate exact source, destination, owner, lamports, account creation, and rent effects. Reject authority or arbitrary transfer patterns outside the approved swap envelope.
5. **Compute Budget:** decode compute-unit limit, unit price/priority fee, loaded-account-data limit, and heap-frame settings. Enforce configured ceilings and reject duplicate, conflicting, malformed, or unsupported settings.
6. **Token and Token-2022:** decode only explicitly supported transfer, transfer-checked, sync-native, initialize-account/associated-account, close-account, and other individually reviewed variants. Validate mint, token program, source/destination owner, authority, decimals, amount, delegate, close authority, extensions, and exact balance effects. Reject approve/revoke, authority changes, confidential or unsupported extension instructions unless separately reviewed.
7. **Associated Token Account:** validate the canonical associated address derivation, owner, mint, token program, payer, and idempotent/non-idempotent creation semantics. Reject unexpected owners or account substitutions.
8. **Jupiter router and route CPIs:** decode the exact supported router instruction versions and validate route accounts and amounts. Where inner CPI effects cannot be independently established from the transaction message and a trusted, version-pinned program interface, do not claim semantic verification. Reject unknown route programs and opaque/unverifiable paths.
9. **All-in funds-flow reconstruction:** reconstruct all SOL, WSOL, SPL and Token-2022 debits/credits, rent, network fee, priority fee, platform fee, and tips. Prove no unapproved destination or excess debit is possible.
10. **Intent binding:** compare the decoded transaction against the immutable server-side intent and reject any mismatch in wallet, cluster, mints, amounts, minimum output, slippage, fees, recipients, expiry, or digest.
11. **Independent signer enforcement:** the isolated signer repeats verification and policy checks itself. It must not trust a Worker-provided attestation without independently validating its authenticated provenance and exact message digest.
12. **Settlement:** after one submission, independently verify finalized transaction execution and owner-scoped pre/post balances against the same intent before ledger mutation.

## Required negative tests

- Unknown program ID, unknown instruction discriminator, unknown instruction variant, malformed instruction data, truncated/oversized data.
- Wrong fee payer, extra signer, signer substitution, unexpected writable account, unexpected executable/program account.
- Lookup table missing, wrong owner, deactivated, not finalized, warmup slot, invalid index, duplicate address, changed table contents, stale context.
- Duplicate/conflicting Compute Budget instructions, excessive compute limit, priority fee, heap size, or loaded-account-data limit.
- System transfer to an unapproved destination, excess lamports, unexpected account creation/assignment/close.
- Token transfer from wrong owner, wrong mint, wrong token program, wrong amount/decimals, delegate authority, close authority, mint/freeze authority mutation, unsupported Token-2022 extension.
- ATA for wrong owner/mint/program, substituted token account, unexpected payer.
- Jupiter route-plan/message mismatch, unapproved router, unknown CPI route, unexpected intermediate token account, unexpected SOL/token outflow, hidden/unsupported tip or fee.
- Expired quote/intent/blockhash, altered message after approval, wrong wallet/cluster/principal, replayed or duplicate idempotency key.
- RPC disagreement, stale lookup data, partial/ambiguous submission, duplicate cron execution, signer outage, failed or non-finalized settlement.
- Fuzz/property tests for all decoders and malformed transaction encodings.

## Acceptance gate

The verifier may set `semanticInstructionVerification: true` and `routeVerification: "semantically-verified"` only after every supported instruction in the complete transaction has a reviewed decoder, every decoded account and value matches the immutable intent, all unsupported instructions fail closed, the independent signer repeats the checks, and the complete positive/negative test matrix passes.

Until then:
- Keep coordinator reservations blocked.
- Keep `executeLiveOrder()` non-executing.
- Keep the Worker without a live execution route.
- Keep Mainnet trading disabled.
- Do not run a funded Devnet transfer without a separately approved disposable-wallet test plan.
- Do not merge PR #40 or deploy to production as part of this plan.


## Source inspection follow-up: PR #40 head `fd3845c32ba4da5ffbf3e2b6666a888617caaff3`

The current implementation and test file were inspected at this exact head.

### Confirmed current parser scope

- `validateUnsignedJupiterTransaction()` performs structural parsing for the supported V0 and V1 message formats.
- `validateAndResolveUnsignedJupiterTransaction()` resolves lookup-table addresses and explicitly preserves `semanticInstructionVerification: false`.
- `validateJupiterBuildResponse()` validates the Jupiter build envelope and its six instruction slots, but returns `routeVerification: "build-envelope-only"`.
- Existing tests cover V1 header/config bounds, signer pinning, instruction/account indexes, lookup-table integrity, malformed structures, and the fact that structurally parsed or build-envelope instructions remain semantically untrusted.
- These tests do not yet decode instruction data into reviewed System, Compute Budget, SPL Token/Token-2022, Associated Token Account, or Jupiter/router semantics.

### Next implementation slice

Before implementing any decoder, add a versioned decoder registry with an explicit reject-by-default contract. Each registry entry must bind an exact program ID, instruction discriminator/variant, supported message context, decoder version, and reviewed account-role schema. The registry must not infer trust from a familiar program ID alone. Add tests proving unknown programs, unknown variants, malformed payloads, and unsupported decoder versions are rejected before any semantic attestation can be produced.

Then implement one instruction family at a time, starting with Compute Budget because its instruction data and global transaction effects can be bounded independently. Validate duplicates/conflicts and configured ceilings. Keep all other instruction families rejected until their own decoders and complete transaction-level funds-flow tests are reviewed.

This follow-up is a source-review and implementation-sequencing note only. It does not alter executable code, semantic trust flags, coordinator gates, signing, submission, Worker routes, deployment, or production data.


## Isolated Compute Budget decoder slice: PR #40 head `5fa022b93793fe4872359a476a11f1d9c0657a49`

Added `compute-budget-decoder.mjs` and `tests/compute-budget-decoder.test.mjs`.

The isolated decoder recognizes four explicitly encoded Compute Budget variants (heap frame, compute-unit limit, compute-unit price, loaded-account-data limit), applies local bounds, preserves u64 priority price as BigInt, and rejects unknown program IDs, unknown/legacy variants, malformed encodings, invalid lengths, and out-of-range values. Its instruction-set helper rejects duplicate variants and unsupported decoder versions.

Scope limitation: this is a syntax decoder for one instruction family only. It is not wired into the unsigned transaction parser, does not verify account roles/privileges or whole-transaction ordering and funds flow, and does not attest semantic route trust. Existing `semanticInstructionVerification: false` and coordinator fail-closed gates remain unchanged. No signing, submission, live route, deployment, or production data operation was added.

CI for this exact head completed:
- Node tests: success (run 44294129397; safety and Durable Objects runtime test job passed).
- Cloudflare Worker build validation: success (run 44294129214; build completed without deployment).
- Devnet read-only: success (run 44294129292).
- Funded Devnet lifecycle: skipped (job 134767019986).

These results validate repository CI for the isolated decoder addition, not full semantic transaction verification or live trading readiness.


## Analysis-only transaction parser slice: PR #40 head `3a6bb7769d93a9b6dfe41e0da31142c12c4a899b`

Added `transaction-instruction-parser.mjs` and `tests/transaction-instruction-parser.test.mjs`.

The new bounded parser accepts an already-deserialized account-key list and compiled-instruction list, checks message and instruction bounds, validates base58-shaped account keys and compiled account indexes, then delegates each instruction to the versioned reject-by-default decoder registry. It currently recognizes only the registered Compute Budget family. System Program, SPL Token, Token-2022, Associated Token Account, and Jupiter/router instructions remain rejected as unsupported.

The parser's output is explicitly analysis-only: `semanticVerification: "incomplete"`, `signingPermitted: false`, and `submissionPermitted: false`. It is not a wire-format transaction parser, does not verify signatures or address lookup table contents, and does not establish CPI effects, token balance deltas, or complete transaction semantics.

Tests cover the supported Compute Budget path, rejection of unregistered System/Token programs, malformed program/account indexes, invalid account keys, malformed instruction data, duplicate variants, and parser bounds.

### Remaining work

1. Implement and independently review System Program instruction decoding and exact lamport/account-creation effects.
2. Add transaction wire-format and address lookup table resolution binding; this parser currently accepts an already-deserialized message only.
3. Add reviewed SPL Token, Token-2022, Associated Token Account, and Jupiter/router decoders one family at a time.
4. Reconstruct all-in SOL/token funds flow and bind every decoded instruction to the immutable server-side order intent.
5. Keep semantic attestation false and all coordinator/signing/submission gates closed until the full acceptance gate above is satisfied.

This slice does not change the semantic trust flags in the existing Jupiter parser, does not enable the LiveTradeCoordinator, and does not add signing, submission, Worker execution routes, deployment, or production data operations.


## Duplicate account-key rejection follow-up: PR #40

The analysis-only transaction instruction parser now rejects duplicate entries in the message-level `accountKeys` array before resolving any compiled instruction indexes. This prevents ambiguous account-index interpretation from entering the decoder path. A regression test supplies the same canonical Compute Budget program key twice and confirms the parser fails closed.

This is an additional structural invariant only. It does not establish signer/writable privileges, decode System Program instructions, reconstruct SOL/token funds flow, verify Jupiter CPI behavior, or produce semantic trust. The parser remains analysis-only and signing/submission remain prohibited.
