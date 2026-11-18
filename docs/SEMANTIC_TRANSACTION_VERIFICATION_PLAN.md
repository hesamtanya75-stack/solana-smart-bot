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



### Independent Token-2022 address candidate located: 2026-11-18

A further source search located a fixed Token-2022 ATA address fixture in
`themusebook/x402-messaging`, at pinned revision
`e9e3b653041503ae6e138d6c356022aab10820e0`, file
`pay-kit-main/lua/tests/methods_solana_ata_spec.lua`.

The fixture states that its expected address is cross-checked against the
project's Ruby reference implementation and `spl-token` CLI, and records:

| Owner | Mint | Token program | Expected ATA address |
|---|---|---|---|
| `CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) | `J1AgP9czKVx1tHY2TrQxMd73tguFUE7rVYynxEWsq8nr` |

This is useful independent, cross-implementation address evidence, but the
inspected fixture does not publish the canonical bump. It is therefore an
address-only candidate, not yet the required fixed address+bump vector. Do not
invent or infer the bump from this table. Before using it as a final test
vector, independently verify the exact owner/mint/token-program tuple and
derive the bump with a second trusted implementation; record the implementation
and version used. The official Solana Foundation `pay-kit` repository also
contains Token-2022 harness fixtures for this owner and program ID, but those
harness excerpts inspected so far do not themselves state the ATA bump.

Sources:
- https://github.com/themusebook/x402-messaging/blob/e9e3b653041503ae6e138d6c356022aab10820e0/pay-kit-main/lua/tests/methods_solana_ata_spec.lua
- https://github.com/solana-foundation/pay-kit/tree/86400da56a35705516f166394a026ea32e8356fb

This is documentation-only evidence collection. No executable code,
dependency, parser status, coordinator gate, signing, transaction submission,
UI, deployment, or production data was changed.


### Official Solana Foundation cross-check for paired ATA addresses: 2026-11-18

The Token-2022 address-only candidate above is now corroborated by the
Solana Foundation's own `pay-kit` repository at pinned revision
`86400da56a35705516f166394a026ea32e8356fb`, file
`lua/tests/methods_solana_ata_spec.lua`.

That test uses the same owner and USDC mainnet mint for both token programs
and explicitly says the expected addresses are cross-checked against the
Ruby reference implementation and `spl-token` CLI:

| Owner | Mint | Token program | Expected ATA address |
|---|---|---|---|
| `CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Classic Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) | `3EjekkZPxiKdDB91mdJjUcjFjRmyWjP1Y4ySvfwSaQ4b` |
| same | same | Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) | `J1AgP9czKVx1tHY2TrQxMd73tguFUE7rVYynxEWsq8nr` |

This establishes a strong, pinned, cross-implementation pair of expected
addresses for one owner/mint tuple and demonstrates that changing only the
token program changes the ATA. The upstream test still does not publish the
canonical bump for either result. Therefore these are verified address
fixtures, but not yet the required address+bump vectors. The bump must be
derived and cross-checked independently before claiming the full vector
requirement is satisfied.

An additional independent SDK implementation was inspected in
`metaplex-foundation/mpl-token-metadata` at pinned revision
`7ce760f9e010cb9819ffd7dd86986a44691bd1f8`,
`clients/js-kit/src/hooked/pdas.ts`. Its `findAssociatedTokenPda`
returns the SDK's `ProgramDerivedAddress` tuple using the same three seed
components (owner, selected token program, mint) and ATA program ID. This is
a suitable independent implementation to use when obtaining the bump, but
no runtime execution of that SDK has been performed in this repository.

Source:
- https://github.com/solana-foundation/pay-kit/blob/86400da56a35705516f166394a026ea32e8356fb/lua/tests/methods_solana_ata_spec.lua
- https://github.com/metaplex-foundation/mpl-token-metadata/blob/7ce760f9e010cb9819ffd7dd86986a44691bd1f8/clients/js-kit/src/hooked/pdas.ts

No executable code, dependency, parser status, coordinator gate, signing,
transaction submission, UI, deployment, or production data was changed.


## Async ATA PDA verifier implementation branch: 2026-11-18

A separate implementation branch, `feat/async-ata-pda-verifier`, now contains
an initial SDK-backed verifier rather than changing the existing syntax parser.

### Fixed paired vectors

For owner
`CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY` and mint
`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, the canonical PDA derivation
produces the already pinned upstream addresses and these bump candidates:

| Token program | Expected ATA | Expected bump |
|---|---|---:|
| Classic Token | `3EjekkZPxiKdDB91mdJjUcjFjRmyWjP1Y4ySvfwSaQ4b` | 251 |
| Token-2022 | `J1AgP9czKVx1tHY2TrQxMd73tguFUE7rVYynxEWsq8nr` | 254 |

The addresses are explicitly present in the Solana Foundation Pay-Kit tests and
cross-checked there against Ruby and `spl-token`. The bump values were computed
from the same owner/mint/program tuples using the canonical PDA hash, seed order,
and Ed25519 off-curve rejection procedure. The SDK-backed tests in this branch
are intended to independently reproduce both address+bump pairs; they must
pass in CI before the values are treated as runtime-validated by this project.

### Code added

- `associated-token-account-pda.mjs` imports `getAddressEncoder` and
  `getProgramDerivedAddress` from exact dependency `@solana/addresses@8.6.0`.
- The selected token program is explicit and restricted to Classic Token or
  Token-2022. Seed order is owner, token program, mint, under the ATA program.
- The helper is asynchronous; no synchronous custom PDA implementation is
  introduced.
- `verifyAssociatedTokenInstructionPda` accepts only a decoder-issued record
  (guarded by the decoder's private WeakSet), and compares the derived address
  to the instruction's associated-account key.
- Result scope is explicitly `pda-only`; it does not claim on-chain existence,
  account ownership, initialization, balance, transaction validity, or
  semantic transaction verification.
- Tests cover both pinned address+bump pairs, distinct outputs by token program,
  malformed owner/mint, unsupported token program, wrong ATA/owner/mint, and
  forged decoder records.

### Validation status: 2026-11-18

The latest implementation head `c296e7664f49d5df9856b246c271f7e393d5d4ec`
has completed these pull-request CI jobs successfully:

- Node tests: run `44385908865` — success. This includes the async parser
  integration test for the fixed Token-2022 ATA address and bump 254.
- Cloudflare Worker build validation: run `44385908988` — success. The job
  installed from the committed lockfile with `npm ci` and completed the
  Wrangler dry-run build without deploying.

The read-only Devnet workflow on the follow-up documentation head
`4dee1870f3ad4f7595626bb59cb2ee3dbbad0e1b` completed successfully:
workflow run `44386026189`. Its unit tests, real Durable Objects runtime
tests, Devnet genesis/health/confirmed-slot checks, reference mint and supply
checks, and read-only RPC validation all passed. The separate funded Devnet
lifecycle job was skipped because this was a pull-request run and no explicit
workflow-dispatch opt-in was supplied. No signing or transaction submission
occurred.

The repository includes a committed npm lockfile v3 (`package-lock.json`)
covering the exact `@solana/addresses@8.6.0` dependency and the resolved project
dependency graph. The Cloudflare Worker validation workflow uses
`npm ci --ignore-scripts --no-audit --no-fund`.

These CI results validate the current SDK integration and Worker build only.
They do not establish complete transaction semantics, CPI effects, on-chain
ATA existence or initialization, signature verification, wallet safety, or
permission to sign or submit transactions.

No merge, deployment, signing, transaction submission, Mainnet trading, or UI
design change is part of this branch. The syntax parser's semantic trust status
and coordinator gates remain unchanged.

## Token-2022 bounded transfer decoder follow-up (PR #43)

The parser now recognizes only the base SPL Token `Transfer` (tag 3) and
`TransferChecked` (tag 12) layouts for both Classic Token and Token-2022.
This is a syntax-decoding increment, not a semantic approval.

- Exact account counts are required; Token-2022 extension extra-account layouts
  (including transfer-hook account layouts) are rejected until separately
  reviewed.
- Other Token-2022 extension instructions, authority changes, approvals,
  confidential transfers, transfer-fee semantics, and CPI effects remain
  unsupported and fail closed.
- Decoded records retain the exact token program ID and are marked analysis-only.
- Transaction semantic verification remains incomplete; signing and submission
  remain disabled.

A fresh CI run on the final code head is required before this increment can be
considered validated.

## CPI and execution-evidence boundary hardening (PR #43)

The message-only syntax parser now rejects transaction execution metadata fields
(`meta`, `innerInstructions`, logs, pre/post balances, pre/post token balances,
and signatures) whether supplied as own or inherited properties, instead of silently ignoring them. This prevents callers from
mistaking a parsed outer-message instruction list for validated execution or
CPI evidence.

This is a fail-closed input-boundary check only. It does not decode inner
instructions, authenticate RPC transaction metadata, verify a transaction
signature, resolve or authenticate address lookup tables, or establish token
balance deltas. A future CPI verifier must bind confirmed transaction metadata
to a verified signature and outer instruction index, validate each inner
instruction group, and independently reconcile pre/post token balances before
any semantic status can advance.

The parser continues to report semantic verification as incomplete, with
signing and submission disabled.

## Strict message input schema hardening (PR #43)

The analysis-only instruction parser now accepts only a plain data record with
the explicit fields `accountKeys`, `instructions`, optional `header`,
`resolvedAddressTableLookups`, `staticAccountKeys`, and
`computeBudgetPolicy`. It rejects unknown string fields (including alternate
execution-metadata containers), symbol keys, custom prototypes, and accessor
properties before reading the message values. The existing explicit rejection
of known execution/CPI metadata remains in place.

This narrows the parser's input contract and prevents unrecognized evidence
containers or getters from being silently ignored/evaluated. It does not
authenticate transaction metadata, verify signatures, validate RPC provenance,
or establish CPI effects or settlement. Semantic verification remains
incomplete; signing and submission remain disabled.

Compiled instruction records are subject to the same fail-closed boundary:
only `programIdIndex`, `accountKeyIndexes`, and `data` are accepted.
Unknown or symbol fields, custom prototypes, accessors, and sparse or
non-data account-index arrays are rejected. This prevents execution evidence
from being smuggled into nested instruction objects while the parser only
inspects the outer message.
Account-index arrays are inspected through own property descriptors before any
index value is read, so accessor-backed indexes are rejected without invoking
their getters. The parser also rejects sparse arrays and non-index own
properties on these arrays.
The top-level account-key and compiled-instruction collections are also
validated as bounded, dense plain arrays before iteration. Custom iterators,
overridden collection methods, symbol properties, extra properties, sparse
slots, and accessor-backed indexes are rejected before the parser can invoke
them.


## Reject detached account-role metadata (PR #43)

The analysis-only message parser now rejects `staticAccountKeys` or
`resolvedAddressTableLookups` unless the caller also supplies the message
header. Previously these optional fields could be accepted and silently ignored
when no header was present, creating an ambiguous input contract in which
callers might believe signer/writable analysis had consumed the supplied role
metadata. The parser now fails closed instead. Regression tests cover each
field independently and together.

This remains structural input validation only. Supplied lookup addresses are
still unauthenticated, the parser does not verify transaction signatures or RPC
provenance, and `accountPrivilegeAnalysis` remains non-authoritative. Semantic
verification remains incomplete; signing and submission remain disabled.


## Direct SPL decoder input hardening (PR #43)

The exported SPL Token decoder and instruction-set validator now independently
snapshot only dense, plain arrays of own data properties before reading values.
This closes a gap where callers bypassing the outer message parser could pass
accessor-backed indexes or instruction collections and cause getters to run.
Custom prototypes, symbol/extra properties, sparse entries, and accessors fail
closed. Regression tests assert getters are not invoked.

This hardens JavaScript input handling only. It does not authenticate account
keys, transaction metadata, signatures, CPI execution, Token-2022 extension
semantics, or balance deltas. Semantic verification remains incomplete and
signing/submission remain disabled.


## ATA instruction-set validation hardening (PR #43)

The exported Associated Token instruction-set validator now independently
requires a bounded plain array and snapshots own data-property entries before
returning the validated records. Sparse entries, accessor-backed entries,
custom prototypes, symbol keys, and extra properties fail closed. Regression
tests verify that accessor getters are not invoked and that ordinary
decoder-issued records continue to validate.

This protects direct callers of the exported validator that bypass the
transaction message parser. It remains JavaScript collection-shape validation
only; it does not establish instruction execution, authenticated transaction
metadata, CPI effects, account state, or settlement. Semantic verification
remains incomplete and signing/submission remain disabled.


## System and Compute Budget decoder collection hardening (PR #43)

The exported System Program decoder now snapshots bounded, dense plain account
index arrays through own data-property descriptors before reading indexes.
Its instruction-set validator applies the same collection boundary to decoded
records. Accessors, sparse entries, custom prototypes, symbols, and extra
properties are rejected without invoking getters.

The Compute Budget instruction-set validators now use the same bounded
snapshot rule. The transaction decoder registry also requires a plain empty
account-index array for the currently reviewed no-account Compute Budget
instruction family. Regression tests cover accessor-backed collections,
decorated arrays, and custom prototypes.

These checks harden JavaScript input handling only. They do not authenticate
transaction signatures or metadata, prove CPI execution, establish account
state or balance deltas, or authorize signing/submission. Semantic verification
remains incomplete and signing/submission remain disabled.


## Message account-role input hardening (PR #43)

The structural account-role helper now snapshots static account keys, the
resolved lookup-table list, each lookup record, and writable/readonly address
lists through own data-property descriptors. It rejects sparse arrays,
accessor-backed entries or fields, custom prototypes, symbol keys, and
unexpected properties before deriving signer/writable roles.

This protects the local analysis boundary against hostile JavaScript objects.
It does not authenticate the source of resolved lookup addresses, prove
finalized lookup-table state, verify signatures, or establish execution or
settlement. A caller-provided lookup result remains untrusted evidence until a
separate trusted RPC resolver verifies its provenance and context.


## Latest PR #43 validation snapshot — 2026-11-18

The current branch head `9e88bcb43b84eaaf894c94e439f558b89aa8f0fa`
completed all three pull-request validation workflows successfully:

- Node tests: workflow run `44394619807` — success.
- Cloudflare Worker build validation: workflow run `44394620013` — success.
- Devnet read-only validation: workflow run `44394619937` — success.

The Devnet job was read-only. This result is not evidence of a funded Devnet buy/sell lifecycle. No signing, transaction submission, production deployment, Mainnet trading, or UI design change occurred. PR #43 remains open and Draft.

The current code still deliberately returns
`semanticInstructionVerification: false` / `semanticVerification: "incomplete"`
for parsed or structurally resolved Jupiter transactions. The LiveTradeCoordinator
continues to reject any route that does not carry a separately established
`semantically-verified` result. This is an intentional safety block, not a
completed semantic verifier.


## Exact PR #43 head audit — 2026-11-19

Reviewed against PR #43 head `609affa13c00ce957f40693bb3307b627808eddb`.

### Current CI evidence for this exact head

- Node tests: run `44409146208` — success. The job includes the safety and Durable Objects runtime tests and the workerd conditional-export check for the ATA SDK.
- Cloudflare Worker build validation: run `44409146196` — success. Wrangler dry-run build only; no deployment.
- Devnet read-only validation: run `44409146240` — success. The job completed unit/runtime tests and Devnet cluster identity/read-only RPC verification.
- Funded Devnet lifecycle: skipped by the workflow because explicit opt-in was not supplied. This is not an on-chain buy/sell test.
- The combined commit status still reports `deploy/hesamtanya75-stack/solana-smart-bot-17` as failure. This is separate from the passing Cloudflare Worker build and does not establish a successful deployment.

### Additional source-level blockers confirmed at this head

- `fetchTrustedSellRoute()` deliberately makes a Jupiter Swap API V2 quote-only request with no taker and requires `transaction: null`. It does not produce an executable build transaction or decoded route evidence.
- `fetchTrustedLiveEvidence()` returns quote and risk evidence but does not produce a `costs` object. The isolated `LiveTradeCoordinator` requires trusted `computeUnitPriceMicroLamports`, `computeUnitLimit`, `maxPriorityFeeLamports`, `baseFeeLamports`, `tipLamports`, `rentLamports`, and `otherOutflowLamports`; missing evidence blocks reservation. Do not fill these fields with browser estimates or guessed constants.
- The coordinator also requires `semanticInstructionVerification: true` and `routeVerification: "semantically-verified"`. The current quote-only sell-route evidence explicitly reports semantic verification false, so reservation remains blocked before any signer action.
- Token-2022 mint inspection is fail-closed: extension-bearing mints are not marked safe until every extension type has a dedicated reviewed policy. The current instruction decoder only recognizes base `Transfer` and `TransferChecked` layouts and rejects unsupported extra-account layouts.
- The managed signer remains a plan only. No Turnkey/Keychain SDK, credentials, signer adapter, or signing route is installed.

### Required next implementation sequence

1. Implement a server-side Jupiter build/evidence path that binds the exact taker, intent, message digest, blockhash, and lookup-table context; keep the resulting evidence untrusted until every instruction is semantically decoded.
2. Derive base network fee from the exact compiled message through trusted RPC; derive priority fee from the decoded Compute Budget instructions; derive rent and tips from decoded account-creation and transfer effects; reconcile every other SOL/token outflow. Reject incomplete or ambiguous evidence.
3. Add reviewed Token-2022 extension parsing and explicit per-extension policy. Continue rejecting unknown, transfer-hook, fee-bearing, confidential, and other unsupported cases until their complete transfer effects and account layouts are independently covered.
4. Complete Jupiter/router and CPI verification, immutable intent binding, and independent finalized settlement reconciliation.
5. Only after the above, perform a provider-neutral mocked signer adapter compatibility test in workerd. Do not install real provider credentials or enable a real signer during this stage.

### Safety disposition

PR #43 remains open and Draft. These CI results do not mean the transaction verifier or live-trading system is complete. Keep semantic verification incomplete, reservation/signing/submission gates closed, and Mainnet trading disabled. No merge, production deployment, wallet signing, transaction submission, or funded Devnet lifecycle was performed as part of this audit.


## Follow-up implementation review — 2026-11-19

A focused review of `trusted-live-evidence.mjs` and `tests/trusted-live-evidence.test.mjs` confirms an important distinction:

- A defensive `validateJupiterBuildResponse()` parser already exists. It snapshots plain records/arrays, bounds instruction and lookup-table resources, checks expected mint/amount intent, validates route-plan shape, and deliberately returns `semanticInstructionVerification: false` with `routeVerification: "build-envelope-only"`.
- The current live evidence path does not call this parser. `fetchTrustedSellRoute()` still calls the Jupiter Swap V2 quote/order endpoint without a taker, requires `transaction: null`, and returns `quote-only-no-transaction`. `fetchTrustedLiveEvidence()` only returns `{ quote, risk, passed }`.
- Therefore the existing /build parser is useful input validation, but it is not a build integration, compiled-message verification, instruction decoder, or evidence of an executable safe route. Do not flip its semantic flag or treat provider-supplied labels/program IDs as trusted semantics.

### Safe next coding slice

Implement a separate, server-side Jupiter build-evidence function and keep it disconnected from reservation/signing until the semantic verifier is complete. It must:
1. Take a server-derived wallet/taker public key and immutable trade intent as explicit inputs; never accept a client-selected taker as authority.
2. Request the documented build response, validate it with `validateJupiterBuildResponse()`, and bind input/output mints, amount, slippage, taker, request/intent ID, and response digest.
3. Independently decode every compute-budget, setup, swap, cleanup, other, tip, and loaded-address instruction against reviewed program-specific decoders. Unknown programs, accounts, account roles, CPI effects, or instruction variants fail closed.
4. Resolve v0 address lookup tables against trusted finalized RPC state and bind the resolved account list to the exact message.
5. Derive base fee from the exact compiled message/RPC fee quote, priority fee from decoded compute-budget instructions, rent from actual account creations, tips from decoded transfers, and all other outflows. Reject missing or conflicting sources.
6. Return evidence marked semantic only after every instruction and account effect is verified. Until then, the coordinator's reservation gate must continue to reject it.

No production integration, key material, signer, transaction submission, or live-trading enablement is authorized by this plan.

## Verified transaction-cost arithmetic helper (PR #43 follow-up)

The branch now includes `verified-transaction-costs.mjs` and
`tests/verified-transaction-costs.test.mjs`. The helper performs exact
`BigInt` arithmetic for the compute-unit priority fee (rounding upward) and
sums base fee, priority fee, tip, rent, and other outflows. It rejects values
outside the canonical unsigned u64 representation and requires all three
explicit evidence gates: semantic instruction verification, message-account
effects verification, and a fee quote bound to the exact compiled-message
digest.

**Integration status: not integrated and not an authorization source.** The
helper does not parse Jupiter instructions, resolve account privileges, prove
recipient or token-account effects, authenticate a fee quote, or verify a
compiled-message digest. Those proofs must be produced by the independent
semantic verifier before this helper can be called. The current runtime route
still reports `quote-only-no-transaction`; it must not set any of the helper's
verification flags. The live-trade coordinator's existing trusted-cost
validation remains unchanged. Do not adapt helper output into coordinator
evidence until the verifier and message-bound fee source exist and are tested
end-to-end.

The new unit tests cover ceiling arithmetic, missing verification gates,
non-canonical/negative/overflowing values, malformed message digests, and
aggregate u64 overflow. These tests have been added to the Node test suite;
their execution on the current PR head remains pending CI confirmation.

## Parser non-authorization regression coverage

The parser test suite now also asserts that caller-supplied approval claims
(e.g. semantic verification, signing permission, submission permission, or
message-effect verification) are rejected as unsupported message fields. A
second regression test asserts that successful decoding still yields a frozen,
analysis-only result with semantic verification incomplete and signing and
submission disabled. This protects the boundary between instruction decoding
and transaction authorization; it does not complete semantic verification.

## Transaction-cost evidence record hardening

The cost helper now snapshots only an exact plain-data schema before reading
values. It rejects inherited records, accessor-backed properties, symbol keys,
unexpected fields, and missing own fields. Regression tests verify that a
hostile getter is rejected without being invoked. This is input-shape hardening
only; it does not make caller-supplied verification booleans authoritative and
does not replace the still-missing independent semantic verifier.

The transaction-cost calculation result is explicitly marked
`analysisOnly: true` and `semanticVerification: "incomplete"`, with both
`signingPermitted` and `submissionPermitted` fixed to false. This prevents a
successful arithmetic result from being mistaken for a transaction approval.
Regression coverage asserts these fields and the frozen result object.

## Quote-only Jupiter payload regression coverage — 2026-11-19

The production trusted-evidence integration test continues to assert that the
current Jupiter route is quote-only, semantically unverified, and has no
all-in-cost evidence. The quote-only route regression now additionally rejects
unexpected non-null transaction payloads (both string and object forms), not
just a missing transaction field. This protects the deliberate no-taker quote
path from silently accepting an executable-looking payload. It does not parse,
authenticate, or semantically verify a Jupiter transaction, and it does not
change the coordinator's fail-closed gate.

## SPL Token decoder record provenance regression

The SPL Token instruction-set validator accepts only record objects registered
by the decoder module itself. Regression coverage now verifies that copying or
freezing a shallow clone of a valid decoded record does not preserve that
provenance and is rejected as unreviewed. This is still syntax/provenance
hardening, not proof of token balance effects, Token-2022 extension behavior,
CPI execution, or semantic transaction approval.

## SPL Token account-privilege negative coverage

Parser regression tests now reject three structurally unsafe layouts when a
message header is supplied: readonly transfer source, readonly transfer
destination, and writable TransferChecked mint. These checks validate only
message-header privilege consistency. They do not prove token-account state,
actual balance deltas, Token-2022 extension effects, CPI behavior, or semantic
transaction safety; parser output remains analysis-only and non-authorizing.

## System and Associated Token decoder provenance regression

System Program and Associated Token instruction-set validator tests now also
reject shallow copies and frozen shallow copies of valid decoder records.
Only the exact record instances registered by each decoder are accepted by
its validator. This is provenance hardening for analysis records only; it does
not establish runtime execution, CPI effects, account-state correctness, or
semantic transaction approval.

## System CreateAccount privilege regression coverage

Parser regression tests now exercise the System Program CreateAccount layout
with message-header-derived privileges. They reject a new-account signer that
is readonly and accept the structurally required writable signer roles while
keeping the parse result analysis-only. This checks message-header structure;
it does not verify account funding, runtime execution, ownership effects, or
whole-transaction semantics.

## Explicit address lookup authentication status

The instruction parser now reports `lookupAddressAuthentication` as
`not-performed` whenever caller-supplied resolved address lookup entries are
present, and `not-applicable` when none are supplied. Matching the supplied
static/loaded key ordering and deriving structural privileges does not prove
which on-chain lookup table was read, its authority, or its state at execution.
This status is diagnostic only and never enables signing or submission.

## Duplicate loaded lookup-address regression

The account-role helper test suite now rejects duplicate resolved addresses
when the same key appears in both writable and readonly loaded groups, and
when it is repeated across separate lookup-table entries. This protects the
flattened v0 account-key list from ambiguous duplicate positions. It remains
structural validation of caller-provided resolved addresses, not proof that
those addresses were authenticated from on-chain lookup-table state.

## Lookup-table decoder provenance boundary

`resolveAddressLookupTableIndexes` now accepts only the exact immutable record
instances produced by `decodeAddressLookupTableAccountData`. A shallow clone,
frozen clone, or caller-constructed lookalike is rejected before index
resolution. Regression tests cover both forged forms and the valid decoder
record. This is an in-process provenance boundary only: it does not authenticate
RPC origin, account ownership, finalized bank context, or SlotHashes ancestry.

## Lookup resolver input snapshot hardening

The lookup index resolver now snapshots its top-level input, index list, and
SlotHashes list as plain data before using them. It rejects inherited/custom
prototypes, unexpected properties, sparse arrays, accessor-backed fields or
entries, out-of-range bank slots, and non-u64 SlotHashes values. Regression
tests assert that getters are not invoked. This prevents caller-controlled
JavaScript object behavior from changing validation while it runs; it does
not authenticate the supplied SlotHashes or establish a same-bank finalized
RPC context.
