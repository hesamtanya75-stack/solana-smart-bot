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

1. Extend the message model to preserve the legacy/v0 message header, static-key signer/writable roles, and resolved address-lookup-table key roles. Only then integrate the isolated System Program syntax decoder into a reject-by-default registry with explicit privilege validation and exact lamport/account-creation effect tests. The current isolated decoder is not a semantic trust source.
2. Add transaction wire-format and address lookup table resolution binding; this parser currently accepts an already-deserialized message only.
3. Add reviewed SPL Token, Token-2022, Associated Token Account, and Jupiter/router decoders one family at a time.
4. Reconstruct all-in SOL/token funds flow and bind every decoded instruction to the immutable server-side order intent.
5. Keep semantic attestation false and all coordinator/signing/submission gates closed until the full acceptance gate above is satisfied.

This slice does not change the semantic trust flags in the existing Jupiter parser, does not enable the LiveTradeCoordinator, and does not add signing, submission, Worker execution routes, deployment, or production data operations.


## Duplicate account-key rejection follow-up: PR #40

The analysis-only transaction instruction parser now rejects duplicate entries in the message-level `accountKeys` array before resolving any compiled instruction indexes. This prevents ambiguous account-index interpretation from entering the decoder path. A regression test supplies the same canonical Compute Budget program key twice and confirms the parser fails closed.

This is an additional structural invariant only. It does not establish signer/writable privileges, decode System Program instructions, reconstruct SOL/token funds flow, verify Jupiter CPI behavior, or produce semantic trust. The parser remains analysis-only and signing/submission remain prohibited.


## Isolated System Program syntax decoder slice

Added `system-program-decoder.mjs` and `tests/system-program-decoder.test.mjs` on PR #40.

The isolated decoder currently recognizes only the exact fixed-width `Transfer` (u32 little-endian variant 2 plus u64 lamports) and `CreateAccount` (variant 0 plus u64 lamports, u64 space, and 32-byte owner) payloads. It requires exactly two compiled account indexes for either variant, rejects other variants and malformed lengths, preserves u64 values as BigInt, and labels returned records analysis-only. Tests cover both supported layouts, unsupported variants/program IDs, malformed lengths/account counts, and forged records.

The initial isolated decoder has since been integrated into `transaction-instruction-parser.mjs` for the exact System Program ID. The parser dispatches System Program instructions to this syntax decoder and applies its provenance validator, while other registered instructions continue through the existing decoder registry. Regression tests cover a Transfer through the parser, wrong account count, and an unsupported System variant. Token and Token-2022 programs remain rejected until their own reviewed decoders and account-role checks are integrated.

This integration is still syntax-only. It does not have authenticated signer/writable metadata, cannot prove required account privileges, and does not establish runtime success, rent sufficiency, account state, CPI behavior, transaction-wide SOL effects, or approved-destination intent. In particular, a decoded Transfer is not proof that the source is the enrolled wallet or that the destination is allowed. The message account-role helper remains separate and caller-supplied lookup addresses remain unauthenticated. Semantic verification, signing, and submission remain disabled.

Format and account-role reference: Solana's official instruction documentation explains that instruction data encoding is program-defined and that signer/writable requirements must be taken from the program implementation; the System Program reference documents Transfer and CreateAccount behavior. This syntax-only slice intentionally does not claim those privilege checks are complete.


## System Program account-index alias rejection follow-up

A review of the isolated System Program syntax decoder found that its two-account variants accepted the same compiled account index in both positions. The decoder now rejects aliased indexes for Transfer and CreateAccount, and regression tests cover both cases. This prevents a source/destination or funding/new-account role collision from being represented as a normal two-account instruction record.

This is still a syntax-level structural check only. It does not validate signer/writable privileges, account identities, runtime effects, rent, approved destinations, or transaction-wide funds flow. The decoder remains isolated from the transaction parser and semantic trust registry; signing and submission remain prohibited.


## Isolated message account-role derivation slice

Added `message-account-roles.mjs` and `tests/message-account-roles.test.mjs`.

The helper derives signer/writable flags for static message keys from the legacy/v0 header counts and appends already-resolved lookup addresses in Solana v0 order: all writable loaded addresses followed by all readonly loaded addresses. Loaded addresses are treated as non-signers. It rejects malformed header counts, noncanonical/duplicate public keys, malformed lookup input, and account-key lists above the 256-key bound. The tests cover static privileges, multiple lookup tables, global writable-before-readonly ordering, and malformed/duplicate inputs.

Important boundary: lookup addresses are caller-supplied and must already have been resolved and authenticated by a separate trusted layer. This helper does not fetch or verify lookup tables, parse raw transaction wire bytes, verify signatures, or establish instruction semantics. It is not yet integrated into the transaction parser or System Program decoder. Semantic verification remains incomplete; signing and submission remain disabled.

CI for the immediately preceding code head `36f9f4b26b5110a1b9109c33255f1b5de36adc2e`: Node tests and Cloudflare Worker build validation succeeded. The latest Devnet read-only workflow is still running; funded Devnet lifecycle remains gated behind explicit opt-in. CI for this documentation update and the subsequent role-helper commits must be checked independently.


## Parser account-index provenance follow-up: PR #40 head `d65b17001ca2c635fecce0511564239ae513d478`

The analysis-only parser now rejects sparse compiled account-index arrays before program dispatch. The System Program syntax decoder preserves a frozen copy of the compiled account indexes on each decoded Transfer/CreateAccount record, and parser tests assert that this provenance survives dispatch.

The account-role helper remains intentionally separate. The parser input still consists of an already-deserialized account-key list and compiled instruction list; it does not carry the legacy/v0 message header or authenticated address-lookup-table resolution evidence. Therefore the parser cannot currently establish signer/writable privileges or prove that a System Transfer source is the enrolled wallet or that its destination is approved. Do not integrate caller-supplied role labels or unverified lookup addresses as trusted authorization evidence.

The sparse-index rejection and index-provenance assertions are structural safeguards only. They do not change `semanticVerification: "incomplete"`, `signingPermitted: false`, or `submissionPermitted: false`, and do not enable coordinator reservations, signing, submission, live Worker routes, or Mainnet trading.

### Next safe implementation boundary

Implement and test a canonical legacy/v0 message-header and static-key privilege parser, then separately authenticate lookup-table account data at finalized commitment before combining the resolved key list. Bind the resulting immutable role records to the exact message digest and compiled instruction indexes. Until those prerequisites are complete, keep the System decoder's output syntax-only and do not treat it as authorization evidence.


## CI evidence for parser provenance checkpoint

Commit `952a6e48e2e6836b98a3914dbe77d8ecaaf8b4b1` completed the repository's Node tests, Cloudflare Worker build validation, and Devnet read-only validation successfully. The `devnet-read-only` job completed successfully, including unit/runtime tests and verification of Devnet cluster identity and read-only RPC methods. The `funded-devnet-lifecycle` job was skipped because explicit opt-in was not supplied; this is an intentional safety gate, not a passing funded lifecycle test.

This CI result validates the current analysis-only parser and role-helper tests/build. It does not validate authenticated address lookup table resolution, full wire-message decoding, wallet enrollment, signing, transaction submission, or Mainnet readiness. PR #40 remains open and draft at this checkpoint.


## API rate-limit boundary review: PR #40 head `2df430ba823fe004e2c18076c10adaf0832d335a`

A source review of `auth-guard.mjs` and `worker.js` confirms that API throttling is enforced through the AuthGuard Durable Object's transactional state. The Worker derives per-route buckets from the Cloudflare `CF-Connecting-IP` value, hashes the address before using it in the bucket scope, and fails closed with HTTP 503 if the rate-limit service cannot be reached. Login, TOTP challenge, and TOTP setup/confirmation have explicit route-specific limits; remaining API routes use route-class limits. The AuthGuard bounds the number of retained rate-limit buckets at 1,000 and rejects new buckets when capacity is exhausted.

Residual limitation: these buckets are per source IP and route scope, not a stable authenticated principal or wallet identity. Distributed requests from many distinct IPs can consume the bounded bucket capacity and cause new source IPs to be throttled until old windows expire. The existing tests cover atomic concurrent consumption, expiry, corrupted state, and capacity behavior, but do not establish resistance to distributed abuse or prove per-user fairness. Before enabling wallet enrollment or unattended trading, add a reviewed principal/session-aware layer in addition to IP throttling, and test capacity-exhaustion behavior under realistic multi-IP load. Do not weaken the current fail-closed behavior as a workaround.

This is a source-review finding, not a confirmed exploit. It does not alter the transaction-verification blockers or authorize signing/submission.

## ALT trust-boundary review at `af5d488cf0a10f930385666cebcc30b2463e781d`

The current `deriveMessageAccountRoles()` helper accepts caller-supplied `writableAddresses` and `readonlyAddresses`. It validates public-key encoding, duplicate keys, array density, and the aggregate 256-account bound, then appends loaded addresses in Solana v0 order (all writable before all readonly). These checks protect the helper's input shape; they do **not** authenticate the source or freshness of those addresses.

Before ALT-derived keys can be used as semantic or signing evidence, a separate resolver must, at minimum:

1. Parse the exact v0 message lookup descriptors and bind each table account key and writable/readonly index list to the message digest.
2. Fetch each lookup-table account from a trusted Solana RPC with an explicit commitment and record the RPC context slot; require finalized state for the verification decision.
3. Verify the account exists, is owned by the Address Lookup Table Program, and its serialized metadata and address vector parse canonically with no trailing or malformed data.
4. Enforce deactivation and extension warmup rules against the relevant finalized bank/slot; reject deactivated, not-yet-active, or otherwise unusable tables.
5. Resolve every requested index against the authenticated address vector; reject out-of-range indexes, duplicate table descriptors, duplicate loaded addresses, and collisions with static keys.
6. Reconstruct the complete key order exactly: static keys, then all loaded writable keys across descriptors, then all loaded readonly keys. Bind the immutable result and context evidence to the exact message digest.
7. Fail closed on RPC disagreement, stale/inconsistent context, missing tables, malformed metadata, or any unresolved index. Do not fall back to caller-provided addresses or a weaker commitment.

### Current status

This is a source-review checklist, not an implementation. The repository helper does not perform RPC retrieval, ALT program-owner or metadata verification, deactivation/warmup checks, or message-to-lookup-descriptor binding. The transaction parser does not currently consume authenticated ALT evidence. Therefore ALT-derived account roles remain untrusted for semantic approval; `semanticVerification` remains `incomplete`, and signing/submission must remain disabled. No live route, signer, or transaction-submission behavior is authorized by this review.


## System Program privilege cross-check slice: PR #40 head `c71eec8ffeb54826f0c9462a967c090d5e8475e7`

The analysis-only transaction parser now optionally accepts the already-deserialized message header and passes static keys plus caller-supplied resolved lookup addresses through `deriveMessageAccountRoles()`. When a header is supplied, the parser cross-checks System Program instruction account privileges:

- Transfer: source must be signer+writable; destination must be writable.
- CreateAccount: funding account and new account must both be signer+writable.

The parser fails closed when a supplied header proves a required privilege is absent. If no header is supplied, it explicitly reports `accountPrivilegeAnalysis: "not-provided"`. A successful structural cross-check is labeled `"structural-match-only"`.

Tests cover a valid Transfer role layout, a readonly source rejection, and the no-header path. All results remain analysis-only: `semanticVerification: "incomplete"`, `signingPermitted: false`, and `submissionPermitted: false`.

Important limitation: this is not authenticated transaction evidence. The parser still accepts already-deserialized input, does not verify signatures or message bytes, and does not authenticate caller-supplied lookup-table addresses. The structural role match does not prove wallet ownership, approved destinations, runtime effects, rent, CPI behavior, or transaction-wide funds flow. Do not use this result as signer authorization.


## Classic SPL Token transfer decoder slice: PR #40 head `78cc3b95712afaa6694b7a20be07c2cae5769127`

Added `spl-token-decoder.mjs` and focused tests for the classic SPL Token program only.

Supported syntax variants:
- `Transfer` (tag 3): exact 9-byte payload and exact three-account single-authority layout.
- `TransferChecked` (tag 12): exact 10-byte payload and exact four-account single-authority layout; amount is retained as BigInt and decimals are decoded.

Multisig layouts and all other token instructions are rejected. Token-2022 is not treated as the classic Token program and remains unsupported. The transaction parser now routes the exact classic Token program ID to this decoder and, when a message header is supplied, structurally checks source/destination writable privileges, authority signer privilege, and readonly mint privilege for TransferChecked.

The parser remains explicitly analysis-only. This decoder does not authenticate token account ownership, mint state, decimals against on-chain mint data, delegate/close authority state, transfer-fee or other Token-2022 extensions, CPI effects, or actual token balance deltas. The caller-supplied account keys and header are not cryptographically authenticated here. Successful structural role checks do not authorize signing or submission; semantic verification remains incomplete and both permissions remain false.

Tests added for exact Transfer and TransferChecked payload decoding, malformed/unsupported layouts, forged/sparse records, parser integration, and rejection when the authority is not a signer. CI must run against the resulting PR head before this slice is considered validated.


## Token-2022 boundary and decoder hardening: PR #40 follow-up

The classic SPL Token decoder now rejects sparse account-index arrays explicitly; a negative test covers this malformed input. The parser also has a regression test proving that the Token-2022 program ID remains rejected by the registry rather than being routed through the classic Token decoder.

Token-2022 is intentionally still unsupported. Its extension instructions and transfer behavior (including transfer fees and transfer hooks) require a separate, versioned decoder and transaction-level account/effect model. Reusing the classic Token decoder would be unsafe because matching a base discriminator does not establish the semantics of extension accounts or CPI effects.

No Token-2022 instruction is accepted, and no semantic trust, signing, or submission permission is granted by this work.


## Associated Token Account decoder slice: PR #40 follow-up

Added an analysis-only decoder for the Associated Token Account program's `Create` (tag 0) and `CreateIdempotent` (tag 1) instructions, with an exact one-byte payload and exact six-account layout. The decoder validates distinct, in-range account indexes and requires the System Program plus either the classic SPL Token or Token-2022 program in the expected account positions. The parser integrates this decoder and structurally checks payer signer+writable, associated account writable, and owner/mint/system/token program readonly privileges when a message header is supplied.

Important limitations:
- The decoder does not derive or authenticate the associated token account PDA from owner, mint, token program, and the canonical associated-token program seeds.
- It does not fetch or verify account existence, ownership, initialization, mint state, rent funding, or Token-2022 extension state.
- The presence of a Token-2022 program account in an ATA Create instruction does not mean Token-2022 token instructions are supported.
- Account privilege checks use caller-supplied, already-deserialized message/header data and are structural only.

Tests cover Create and CreateIdempotent, classic Token and Token-2022 program-account selection, malformed layouts, duplicate indexes, forged/sparse records, parser integration, and a non-signer payer rejection. Semantic verification remains incomplete; signing and submission remain disabled.


### ATA privilege hardening follow-up

The parser's structural privilege cross-check now additionally requires the derived ATA destination to be writable and not a transaction signer, and requires the System Program and selected Token Program accounts to be readonly non-signers. Regression tests cover rejection of a signer-marked destination and a writable System Program account. This remains a structural check only; it does not prove the destination is the canonical PDA or that the on-chain account state is valid.


### Explicit ATA address-verification status

Parser output now reports `associatedAddressVerification: "not-performed"` whenever an ATA instruction is present, and `"not-applicable"` otherwise. This prevents downstream consumers from mistaking account-role/layout checks for cryptographic PDA verification. Regression tests assert both states. PDA derivation and authenticated account-state validation remain outstanding; signing and submission remain disabled.


### ATA role-key distinctness and PDA boundary

The ATA role-layout check rejects unsupported account-index aliasing while recognizing the canonical compiled-message representation of `payer === owner`: both roles use the same account index because message account keys are deduplicated. A repeated index is permitted only for the payer/owner pair; other role-index collisions remain rejected. When payer and owner share the index, the global message privilege is signer+writable (the union of both roles), so the parser does not incorrectly require that shared account to be readonly/non-signer. For distinct payer and owner indexes, owner and mint must be readonly non-signers. Regression tests cover the valid shared-index case and reject a distinct owner marked as signer.

PDA verification remains intentionally unimplemented in this slice: the inspected Node package manifest has no Solana or audited Ed25519/PDA dependency and no lockfile was present at the inspected branch paths. Do not substitute a handwritten curve-point test or a length-only public-key parser. Before enabling canonical ATA verification, select and pin a maintained, audited Solana-compatible implementation, establish reproducible dependency locking for this repository, and add known-vector tests for owner/token-program/mint seeds, bump search, off-curve rejection, and wrong-address rejection. Until then the parser must continue to report `associatedAddressVerification: "not-performed"`.


### Compute Budget policy-ceiling helper

Added `validateComputeBudgetPolicy()` to the isolated Compute Budget decoder. It requires explicit caller-supplied ceilings for compute units, heap frame, loaded-account data, and priority fee. It calculates the priority fee conservatively with integer arithmetic and rounds micro-lamports up to the next lamport. Tests cover accepted values, each ceiling, missing/invalid policy, and fee calculation.

This helper is not yet wired into transaction admission or the live-trade coordinator, and it does not infer Solana runtime defaults. The caller must supply a reviewed policy. It does not authorize semantic route verification, signing, or submission.


### Coordinator fail-closed regression coverage

Added coordinator tests proving that unsigned-structure-only evidence, build-envelope-only evidence, a contradictory semantic boolean, or missing sell-route evidence cannot create a reservation. The test asserts HTTP 409 and an unchanged empty reservation ledger for each case.

This is policy-gate regression coverage using mocked evidence. It does not implement a production semantic verifier or prove a real Jupiter transaction safe. Production evidence remains unverified and the coordinator must continue to block reservations until a complete reviewed verifier exists.


### Transaction parser Compute Budget policy integration

The analysis-only transaction parser now accepts an optional explicit `computeBudgetPolicy` object on its message input. When supplied, it applies the caller's complete set of required ceilings to the decoded Compute Budget instructions and returns a frozen `computeBudgetPolicy` result with status `validated`. A missing policy is explicitly reported as `not-provided`; invalid or exceeded limits reject parsing. Regression tests cover successful policy application, a compute-unit ceiling breach, and incomplete policy input.

This is a bounded policy check for the decoded Compute Budget instruction family only. It does not infer runtime defaults, prove fee payer balance, validate all transaction costs, or establish transaction/route semantic trust. The parser continues to return `semanticVerification: "incomplete"`, `signingPermitted: false`, and `submissionPermitted: false`.


### Compute Budget policy ceiling bounds

The caller-supplied policy ceilings are now themselves constrained to the decoder's supported protocol ranges: compute units 1–1,400,000; heap frame 32,768–262,144 bytes in 1,024-byte increments; loaded account data 1–64 MiB. Invalid policy configuration is rejected before comparing decoded instruction values. Regression tests cover over-limit compute units, misaligned and oversized heap ceilings, and loaded-data ceilings above 64 MiB.

This hardens configuration validation only; it does not expand semantic coverage or authorize signing/submission.


### Associated Token account role alias correction

The syntax decoder now distinguishes account-index uniqueness from public-key equality. The six compiled account indexes must remain distinct, but the public keys at different role indexes are not required to be distinct: in a normal ATA creation flow the payer and token-account owner may be the same wallet. The previous blanket public-key uniqueness check rejected this valid layout. Regression coverage now accepts payer = owner while continuing to reject repeated account indexes.

This remains syntax/structure analysis only. It does not derive or authenticate the ATA PDA, inspect on-chain account state, or establish transaction semantics.


## Canonical ATA payer-owner compiled-index correction — PR #40 follow-up

A deeper review identified that the prior alias test modeled payer and owner as the same public key at two different indexes. That is not the canonical compiled-message representation because transaction account keys are deduplicated. When payer and owner are the same wallet, both instruction roles must reference the same account index.

The ATA decoder now permits exactly this one index alias (payer/owner) and rejects collisions among all other role pairs. The parser's structural privilege check accounts for Solana's message-wide privilege union: the shared payer/owner index remains signer+writable; for distinct roles, owner and mint must be readonly non-signers. Tests cover successful shared-index parsing and rejection of a distinct signer owner.

This is still structural-only validation. It does not derive or verify the ATA PDA, authenticate lookup tables or account state, or prove transaction semantics. The parser continues to report `associatedAddressVerification: "not-performed"`, `semanticVerification: "incomplete"`, and both signing/submission permissions false.


## Instruction program-account privilege cross-check

When a message header is supplied, the structural parser now also checks every compiled instruction's program account index and requires that account to be readonly and a non-signer. This is separate from checking the instruction's operand accounts and closes a structural gap where a program account could otherwise be marked writable or signer while the parser still reported a privilege match. Regression tests cover both invalid privilege states.

This remains a structural check over the caller-supplied, already-deserialized message and header. It does not authenticate the program executable, prove program identity beyond the account-key string, authenticate address lookup table contents, or establish instruction semantics. Signing and submission remain disabled.


## Versioned-message static and lookup account ordering

For structural privilege analysis of a v0 message, the parser now requires the caller to provide `staticAccountKeys` separately whenever resolved address lookup tables are present. The complete `accountKeys` list remains the index-addressable key list used by compiled instructions. The parser independently derives the canonical order (static keys, all loaded writable keys, then all loaded readonly keys) and requires an exact key-for-key match with `accountKeys` before checking any signer or writable privilege.

This prevents the parser from treating the already-expanded key list as static keys and appending lookup addresses a second time, which could otherwise misalign privilege indexes. Regression tests cover a valid loaded writable destination, missing static-key metadata, and a mismatched expanded key order.

This validates only the consistency of caller-supplied decoded inputs. It does not fetch or authenticate lookup-table accounts, verify their on-chain contents or slot state, or establish semantic transaction verification. Signing and submission remain disabled.


## ATA PDA SDK selection research — follow-up to PR #41

The ATA decoder must not implement Ed25519 point validation or PDA bump search by hand. The current project manifest targets Node.js >=20 and currently declares no Solana SDK dependency. The inspected PR #41 branch also has no npm, pnpm, Yarn, or Bun lockfile.

### Protocol inputs confirmed from Solana documentation

The canonical ATA PDA uses the Associated Token Account Program as the deriving program and the ordered seeds:

1. wallet/owner public-key bytes;
2. selected token-program public-key bytes (classic Token or Token-2022);
3. mint public-key bytes.

The token-program ID is part of the seeds, so the classic Token and Token-2022 addresses must be derived independently. The payer is not a PDA seed. The canonical bump is found using Solana's PDA derivation algorithm, which hashes the seeds, program ID, and `ProgramDerivedAddress` marker, rejecting on-curve results.

References:
- https://solana.com/docs/tokens/basics/create-token-account
- https://solana.com/docs/core/pda/pda-derivation
- https://github.com/solana-program/associated-token-account/blob/main/interface/src/address.rs

### SDK candidate — not yet installed

Solana's current JavaScript documentation recommends `@solana/kit` for new TypeScript development and documents the `getProgramDerivedAddress` API. This is the preferred candidate for evaluation in this project. Do not assume that legacy `@solana/web3.js` v1 examples or APIs are interchangeable with the current Kit API.

References:
- https://solana.com/docs/clients/official/javascript
- https://solana.com/docs/core/pda/pda-derivation

No dependency is added in this documentation-only step. The SDK choice must be validated against this repository's Node test runner and Cloudflare Worker bundling/runtime before installation. Then pin an exact version, generate and commit the repository's lockfile using the matching package manager, and require clean-lockfile installation in CI. Do not use a floating version or hand-authored lock metadata.

### Required implementation and tests before changing the parser status

- Use the selected SDK's canonical PDA derivation API; do not write a custom curve test, SHA-256 derivation, or bump loop.
- Derive with both classic Token and Token-2022 program IDs and prove they yield different addresses for the same owner and mint.
- Add fixed expected-address and bump vectors independently cross-checked against the official Associated Token Account implementation or a trusted Solana SDK.
- Reject malformed owner, mint, token-program, and ATA program IDs before derivation.
- Test wrong owner, wrong mint, wrong token program, wrong ATA program, wrong bump/address, and on-curve candidate rejection using SDK-supported primitives and fixed vectors.
- Keep `associatedAddressVerification: "not-performed"` until the new derivation is integrated into the parser and all tests pass.
- Keep authenticated on-chain account-state checks as a separate later requirement; deriving the expected address alone does not prove an account exists or is correctly initialized.

This research note changes no executable code, parser trust flags, coordinator gates, wallet signing, transaction submission, deployment, or production data. Mainnet trading remains disabled.


### Repository-specific Worker build gate

The inspected `.github/workflows/cloudflare-worker-validation.yml` runs on pull requests that change `package.json`, `worker.js`, `wrangler.jsonc`, or tests. Its validation step runs `npx --yes wrangler@4 deploy --dry-run --config wrangler.jsonc`; this is a build-only dry run, not a deployment. Therefore, a future SDK dependency change to `package.json` will trigger this Worker bundling check. The current workflow does not run a clean install from a committed project lockfile, so it does not by itself prove lockfile reproducibility.

The official SDK documentation lists `@solana/kit` as the recommended TypeScript SDK and exposes `getProgramDerivedAddress`. The published `@solana/kit` package describes Node, web, and React Native support, but that broad statement is not a project-specific Cloudflare Workers compatibility guarantee. A changelog entry for one transitive `@solana/errors` package adding `workerd` and `edge-light` exports is useful evidence, but it does not establish that every package in the SDK dependency graph is Worker-compatible. Treat the Wrangler dry-run plus a focused runtime test in the actual Worker environment as required evidence before relying on this SDK for PDA verification.

References:
- https://solana.com/docs/clients/official/javascript
- https://solana.com/docs/core/pda/pda-derivation
- https://www.npmjs.com/package/@solana/kit
- https://github.com/anza-xyz/kit/blob/main/packages/errors/CHANGELOG.md


### Confirmed integration constraints from the current repository

The current Worker entry point is `worker.js` and is an ES module importing local `.mjs` modules. `wrangler.jsonc` sets `compatibility_date` to `2026-11-06`; it does not declare an explicit `compatibility_flags` array. Cloudflare's current compatibility documentation states that dates on or after `2026-08-04` enable Node.js compatibility behavior by default. This is useful context, but the PDA implementation should still prefer SDK paths that run on standard Web APIs and should not depend on Node-only crypto or Buffer behavior.

The repository currently has no `@solana/kit` dependency and no committed npm lockfile in this branch. `package.json` uses Node `>=20`, has a `test` script of `node --test`, and currently lists only `better-sqlite3` as a production dependency. The Worker validation workflow invokes Wrangler's `deploy --dry-run` when `package.json` or Worker/test paths change. Cloudflare documents that Wrangler uses esbuild, resolves npm dependencies, honors conditional package exports, and selects the `workerd` export condition when bundling for Workers.

Implementation gate: when the SDK is introduced, verify the actual resolved `@solana/kit` dependency graph has a usable `workerd`/browser-compatible path (rather than assuming one transitive package's export is sufficient), run the existing Node test suite, run the repository's Wrangler dry-run build, and add a focused test in a real Workers-compatible runtime. Do not alter `compatibility_date` or enable new Node compatibility flags merely to make a dependency load without a documented need and a separate review.

References:
- https://developers.cloudflare.com/workers/wrangler/bundling/
- https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- https://solana.com/docs/clients/official/javascript



### Smaller direct-package candidate: `@solana/addresses`

A follow-up package-level review found that the documented `getProgramDerivedAddress` helper is also published from the standalone `@solana/addresses` package. This creates a narrower candidate than importing the umbrella `@solana/kit` package when the implementation needs only address/PDA derivation.

The package metadata inspected during this review lists stable release `8.6.0` and five direct dependencies. Treat that version as a research candidate only, not as an approved or installed dependency. A smaller direct package may reduce the dependency surface, but its transitive exports and actual Cloudflare Workers runtime behavior still require verification.

Before choosing between `@solana/addresses` and `@solana/kit`:

- Confirm the exact exported import path and API against the pinned package version.
- Inspect the complete resolved dependency graph and package export conditions; do not infer Worker compatibility from one dependency's `workerd` export.
- Generate the lockfile with the repository's chosen package manager and prove a clean frozen/locked install.
- Run all Node tests, the Wrangler Worker dry-run, and a focused test using the actual Workers-compatible runtime.
- Keep the ATA parser result at `not-performed` until fixed-vector tests and parser integration pass.

No package has been installed or added by this research note. No executable code, parser trust status, coordinator gate, signing, submission, deployment, or production data has changed.



### API-shape finding: PDA derivation is asynchronous

The published `@solana/addresses` API reference documents `getProgramDerivedAddress` as returning a `Promise<[Address, bump]>`, and its example awaits the call. The documented import path is directly from `@solana/addresses`, with `getAddressEncoder` used to encode the owner, token-program, and mint seed addresses.

This matters to the current repository: `parseSupportedInstructionMessage()` is presently synchronous. Integrating the SDK helper directly therefore requires an explicit design decision to make the parser asynchronous and update every caller/test accordingly, or to keep syntax parsing synchronous and introduce a separate asynchronous PDA-verification stage. Do not block the event loop or replace the SDK with a hand-written synchronous derivation algorithm to preserve the current function signature.

The safer staged option is to keep the existing syntax parser and its `not-performed` status unchanged, then add a distinct async verification layer with fixed vectors and explicit result binding. The parser must not claim semantic verification merely because PDA derivation succeeds; the on-chain ATA account state remains a separate check.

References:
- https://www.solanakit.com/api/functions/getProgramDerivedAddress
- https://www.npmjs.com/package/@solana/addresses?activeTab=versions

This is a research/design note only. No executable code or parser API has changed.

## SDK package and Cloudflare export audit: 2026-11-18

Inspected the published `@solana/addresses@8.6.0` package metadata and the matching upstream `anza-xyz/kit` tag.

Confirmed package facts:

- The package declares explicit conditional exports for `workerd`, `edge-light`, `browser`, `node`, and `react-native`. The `workerd` condition resolves to the package's Node-targeted ESM/CJS distribution files; this is an explicit Workers runtime export, not an inference from its browser build.
- The implementation of `getProgramDerivedAddress()` uses `crypto.subtle.digest('SHA-256', ...)`, `TextEncoder`, and `Uint8Array`. It checks for digest capability before deriving. These are APIs available in the Workers runtime, but this source inspection alone is not a substitute for executing the built package inside the project's actual Workers-compatible test runtime.
- The function is asynchronous and returns the PDA and bump as a tuple. It tries bump seeds from 255 downward and retries only when the candidate digest is on the Ed25519 curve.
- The implementation enforces at most 16 seeds and at most 32 bytes per seed. ATA derivation uses three 32-byte public-key seeds plus the one-byte bump, within those limits.
- The package's direct runtime dependencies are `@solana/assertions`, `@solana/codecs-core`, `@solana/codecs-strings`, `@solana/errors`, and `@solana/nominal-types`. This is a small standalone package compared with importing the full `@solana/kit` package, but it is not dependency-free.
- Its declared Node engine is `>=20.18.0`; the repository currently declares `>=20`. CI must therefore verify the actual pinned Node version before adopting this package. Do not silently raise the repository's engine floor as part of an ATA-only change.

### Adoption gate

The source audit supports keeping `@solana/addresses@8.6.0` as the leading SDK candidate, but does not yet establish that it is safe to add to this repository. Before adding it:

1. Verify the repository's actual Node version in all test and build workflows against the package's `>=20.18.0` engine.
2. Install the exact pinned version and commit the package-manager lockfile; do not use an unpinned or floating dependency.
3. Run the package through the existing Node test suite and the existing Wrangler dry-run build.
4. Add a focused test that imports the built Worker bundle in the project's Workers-compatible runtime and derives known ATA vectors for both Classic Token and Token-2022.
5. Cross-check expected address and bump vectors against the official Associated Token Program implementation or an independent trusted implementation.
6. Test malformed keys, incorrect program IDs, wrong token program, wrong owner/mint, and on-curve rejection. Keep the verifier async and separate from the synchronous syntax decoder.
7. Preserve `semanticInstructionVerification: false` and all coordinator fail-closed gates until the complete semantic-verification acceptance matrix is satisfied.

No dependency was added by this audit. No executable source, parser behavior, signing, transaction submission, Worker routes, UI/design, deployment, or production data was changed.

### Repository CI engine-floor cross-check: 2026-11-18

The repository files were checked against the SDK's declared Node engine:

- Root `package.json` declares `engines.node: >=20`.
- `.github/workflows/test.yml` selects Node 22 for the Node test job.
- `.github/workflows/cloudflare-worker-validation.yml` selects Node 20 for the Wrangler dry-run job.
- The candidate `@solana/addresses@8.6.0` package declares `engines.node: >=20.18.0`.

The Node 22 test job is above the candidate's stated floor. The Wrangler workflow requests the Node 20 major line, not an explicit patch/minor floor; the workflow currently uses the hosted setup-node Node 20 distribution, but the repository does not pin or assert Node >=20.18.0 in that job. Therefore the engine compatibility check is not fully deterministic from workflow configuration alone.

Before adoption, make the Wrangler job's Node version explicit at 20.18.0 or newer (or align both workflows on Node 22 after confirming Wrangler compatibility), then run the dry-run build. Do not change the workflow as part of this documentation-only audit.

No dependency or lockfile was added. No workflow, executable code, parser, UI, signing, transaction, or deployment behavior was changed.



## Official ATA program test-fixture cross-check: 2026-11-18

Inspected the upstream Associated Token Account program's pinned source revision
`solana-program/associated-token-account@fbf5379`, specifically
`pinocchio/program/tests/bump.rs` and `pinocchio/program/tests/common.rs`.

The upstream tests provide independently sourced canonical-bump fixtures for the
Classic Token program and explicitly exercise both Classic Token and Token-2022
through a token-program test matrix:

| Wallet | Mint | Token program | Expected canonical bump |
|---|---|---|---:|
| `1117mWrzzrZr312ebPDHu8tbfMwFNvCvMbr6WepCNG` | `8N6gdBxJaZUG9cBnSSaHDsx7vMeQ4VR1LmCmk9SCu38s` | Classic Token | 255 |
| `111FJo4zLAGU9nzTWa6EnbV4VAmtG4FR8kcokrtZYr` | same mint | Classic Token | 254 |
| `3zPynWFGj3nyJBtHhCy8UEJoGvbn1TmgHca2afHTSByQ` | same mint | Classic Token | 253 |
| `931gKnvtYWR12hueG8Zb1yDigAntDghosriFUoK1Fr8P` | same mint | Classic Token | 253 |

The upstream source also gives a negative fixture for the last wallet: bump 254
produces the on-curve address
`2XughgGgvRsf8VJiteF7ZEYF2jZbCTcTAFoEfrCfUXs7`, while the canonical bump is
253. The upstream test asserts that the canonical result is off-curve and that
the incorrect on-curve bump hint is rejected.

Important limitation: these upstream tests expose the expected bump values and
one deliberately incorrect on-curve candidate, but this inspection did not
establish a fixed canonical ATA address string for each positive fixture.
Therefore, do not copy a guessed address into JavaScript tests or claim the
complete address+bump vector requirement is satisfied. The next test-authoring
step must independently derive and cross-check the canonical address strings
for these same fixtures, and add at least one Token-2022-specific address+bump
pair from the official program or another independent trusted implementation.

The upstream tests' Token-2022 matrix confirms that the canonical derivation
path is exercised with both token program IDs, but it is not by itself a
published fixed expected-address vector for the Token-2022 case. Keep
`associatedAddressVerification: "not-performed"` until both program variants
have fixed address+bump vectors and the repository's Node and Workers-runtime
tests pass.

Sources:
- https://github.com/solana-program/associated-token-account/blob/fbf5379e7398ac8b231c73ee8a9ff677b43dd0ec/pinocchio/program/tests/bump.rs
- https://github.com/solana-program/associated-token-account/blob/fbf5379e7398ac8b231c73ee8a9ff677b43dd0ec/pinocchio/program/tests/common.rs
- https://github.com/solana-program/associated-token-account/blob/fbf5379e7398ac8b231c73ee8a9ff677b43dd0ec/interface/src/address.rs

This source cross-check changes documentation only. No dependency, executable
code, parser status, coordinator gate, signing, transaction submission, UI,
deployment, or production data was changed.


### Seed-order and legacy-helper review

A direct read of the same pinned upstream `interface/src/address.rs` confirms the
canonical seed order used by the official ATA helper:

1. Wallet/owner public-key bytes.
2. Selected token-program public-key bytes.
3. Mint public-key bytes.

The PDA program is the Associated Token Account Program ID. The upstream
`get_associated_token_address_with_program_id` helper passes the selected token
program ID into that derivation path. The older two-argument
`get_associated_token_address` helper is explicitly deprecated because it
assumes the Classic SPL Token program and does not work for Token-2022 mints.

Implementation consequence: do not use the deprecated two-argument helper for
the verifier. The selected token program must be an explicit, validated input,
and it must occupy the second seed position. Add a regression test that swaps
the token-program and mint seed positions and confirms the resulting address
does not match the canonical fixed vector.

This review confirms the source-level seed contract only. It does not supply
the missing fixed ATA address strings, prove the SDK package runtime behavior,
or authorize changing `associatedAddressVerification` from
`"not-performed"`.

Pinned upstream source:
- https://github.com/solana-program/associated-token-account/blob/fbf5379e7398ac8b231c73ee8a9ff677b43dd0ec/interface/src/address.rs

No executable code, dependency, parser status, coordinator gate, signing,
transaction submission, UI, deployment, or production data was changed.


### Clarification: scope of the upstream Token-2022 matrix

The `pinocchio/program/tests/bump.rs` source was re-read in full to avoid
overstating what its Token-2022 matrix proves. The fixed wallet/mint/bump cases
listed above are Classic Token fixtures. The Token-2022 matrix at the end of
that test file uses a dynamically constructed harness wallet and mint and checks
acceptance of an existing ATA using a bump computed at runtime; it does not
publish a fixed Token-2022 address+bump pair.

Accordingly, the upstream source currently gives:
- Fixed Classic Token wallet/mint/bump fixtures, plus negative bump/address cases.
- Runtime-derived Token-2022 acceptance coverage in a program test matrix.
- No fixed Token-2022 address+bump fixture in the inspected test file.

This distinction is mandatory in any implementation report. A future fixed
Token-2022 vector must be independently generated and verified against the
official helper using the explicit Token-2022 program ID; a runtime-computed
expected value inside the same test is not an independent fixed vector.

No executable code, dependency, parser status, coordinator gate, signing,
transaction submission, UI, deployment, or production data was changed.
