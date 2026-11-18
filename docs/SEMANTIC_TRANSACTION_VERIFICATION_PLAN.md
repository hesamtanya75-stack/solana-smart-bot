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

The syntax-only ATA decoder now also rejects duplicate public-key strings across its six role accounts, even when the compiled account indexes differ. A regression test covers the duplicate-key substitution case. This is an additional structural guard, not PDA derivation.

PDA verification remains intentionally unimplemented in this slice: the inspected Node package manifest has no Solana or audited Ed25519/PDA dependency and no lockfile was present at the inspected branch paths. Do not substitute a handwritten curve-point test or a length-only public-key parser. Before enabling canonical ATA verification, select and pin a maintained, audited Solana-compatible implementation, establish reproducible dependency locking for this repository, and add known-vector tests for owner/token-program/mint seeds, bump search, off-curve rejection, and wrong-address rejection. Until then the parser must continue to report `associatedAddressVerification: "not-performed"`.


### Compute Budget policy-ceiling helper

Added `validateComputeBudgetPolicy()` to the isolated Compute Budget decoder. It requires explicit caller-supplied ceilings for compute units, heap frame, loaded-account data, and priority fee. It calculates the priority fee conservatively with integer arithmetic and rounds micro-lamports up to the next lamport. Tests cover accepted values, each ceiling, missing/invalid policy, and fee calculation.

This helper is not yet wired into transaction admission or the live-trade coordinator, and it does not infer Solana runtime defaults. The caller must supply a reviewed policy. It does not authorize semantic route verification, signing, or submission.
