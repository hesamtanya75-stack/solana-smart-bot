# CPI semantic-decoder requirements

## Audit scope

This note records the boundary of the current CPI observation and top-level instruction decoders. The latest validation checkpoint is PR #56 head `2ce7654049e1f9b1c0de3f6b6f9e706e5209f9f4`. It is a design/audit artifact only. It does not authorize reservations, signing, submission, deployment, or Mainnet trading.

## Verified current implementation boundary

- `simulation-observation.mjs` bounds and normalizes Solana simulation `innerInstructions`, including top-level instruction group indexes, program/account indexes, base58 instruction data, and optional stack heights.
- `resolveSimulationCpiIndexesAgainstTrustedMessage()` requires privately branded unsigned-message evidence and resolves observed indexes to candidate program/account public keys. It explicitly reports candidate-only resolution and leaves CPI program identity, semantic verification, token effects, signing, and submission unverified/false.
- `transaction-instruction-parser.mjs` parses top-level compiled message instructions only. It rejects execution metadata and CPI evidence as parser input, and always returns `semanticVerification: "incomplete"`, `signingPermitted: false`, and `submissionPermitted: false`.
- The current decoder registry is version 1 and supports Compute Budget as its generic registry entry. Separate version-1 decoders cover bounded System Program, SPL Token/Token-2022, and Associated Token instructions at the top-level parser boundary. The SPL Token-2022 decoder explicitly leaves extension semantics uninspected.
- These decoders do not constitute a Jupiter/DEX CPI decoder registry. A decoded top-level instruction, candidate CPI program ID, stack height, or simulation success must not be promoted to semantic route approval.

## Required design before any CPI semantic claim

1. **Program identity and version pinning**
   - Maintain an explicit allowlist per supported CPI program ID.
   - Bind each decoder to a reviewed program version/build identity and a documented upgrade policy. A program ID alone is not a code-version pin.
   - Reject unknown programs, unknown versions, upgrade-authority uncertainty where relevant, and unsupported instruction variants.
2. **Instruction decoding**
   - Decode the exact CPI instruction data format with strict length, enum, integer, and canonical-encoding checks.
   - Validate every account position, duplicate/alias constraints, signer/writable privilege expectations, and relationships to the parent instruction.
   - Reject unsupported optional accounts, remaining-account layouts, hooks, extensions, and dynamic variants rather than guessing.
3. **Invocation tree**
   - Associate each inner-instruction group with its exact top-level message instruction.
   - Validate stack-height progression and parent/child relationships when the RPC provides stack heights. Missing or inconsistent hierarchy must remain unresolved.
   - Preserve invocation order; do not treat a flat list as a complete call tree.
4. **Value-flow reconciliation**
   - Reconcile every value-moving System, native SOL/WSOL, SPL Token, and Token-2022 operation across the complete invocation tree.
   - Account for fees, rent/account creation, tips, close-account refunds, wrapped-SOL sync/close behavior, transfer hooks, and any other supported outflow.
   - Bind expected input/output mints, amounts, token programs, owners, destinations, and minimum-output/slippage policy to the immutable order intent.
   - Require finalized account/transaction evidence for settlement; simulated pre/post balances are diagnostic and are not finalized settlement evidence.
5. **Evidence provenance**
   - Do not infer that the RPC simulated the exact supplied bytes from a matching request ID or a caller-provided digest. Require a provider-authenticated attestation or independently reproducible execution before treating remote simulation identity as verified.
   - Keep simulation observations separate from transaction-message evidence and finalized settlement evidence.
6. **Negative tests**
   - Cover unknown or changed program versions, unknown instruction discriminators, malformed/truncated data, account-index substitution, privilege escalation, parent mismatch, invalid stack-height transitions, hidden extra outflows, fee/rent/tip omissions, Token-2022 extension/hook paths, and simulation/RPC identity ambiguity.
   - Assert every rejected case leaves reservations, daily spend, and open-position state unchanged.

## Release rule

Until all supported CPI programs and variants satisfy the above requirements end to end, production sell-route semantic verification remains false and the coordinator must continue rejecting reservations. No partial decoder coverage may be described as complete Jupiter route verification.

No UI/design changes are in scope.


## Validation checkpoint — 2026-11-21

At PR #56 head `2ce7654049e1f9b1c0de3f6b6f9e706e5209f9f4`, the latest GitHub Actions runs completed successfully:

- Node tests: pass (run #1995).
- Cloudflare Worker build validation: pass (run #1501; build only, no deploy).
- Devnet signed lifecycle validation workflow: pass (run #1568); its read-only validation and Durable Objects tests passed, while the funded Devnet lifecycle remained skipped because no explicit opt-in was supplied.

The test-fixture correction in this checkpoint isolates malformed account-key cases from the independent requirement that owned finalized token-balance rows include a valid `accountIndex`. It does not weaken the settlement validator.

The following release blockers remain intentionally unresolved: authenticated association of the remote simulation response with exact transaction bytes; version-pinned CPI program identity and instruction decoding; complete invocation-tree and account-role validation; reconciliation of all SOL, WSOL, SPL Token, and Token-2022 value effects; and independently verified all-in costs. No standard JSON-RPC request ID, HTTPS endpoint, local digest, or successful simulation is treated as provider attestation.

PR #56 remains open and Draft. These passing checks do not authorize merge, production deployment, wallet signing, transaction submission, funded Devnet execution, or Mainnet trading.
