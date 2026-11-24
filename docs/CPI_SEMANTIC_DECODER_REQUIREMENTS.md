# CPI semantic-decoder requirements

## Audit scope

This note records the boundary of the current CPI observation and top-level instruction decoders. The latest validation checkpoint is PR #56 head `e48ffcc78eaf509c3b5e04130c015aae16792b60`. It is a design/audit artifact only. It does not authorize reservations, signing, submission, deployment, or Mainnet trading.

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


## Follow-up CI checkpoint — 2026-11-21

The documentation checkpoint commit `ec9fe078e501926f4b4bd1c8ac2e58ae633d0953` completed its pull-request checks:

- Node tests run #1996: success. The isolated Durable Objects runtime tests, dependency audit gate, and ATA SDK workerd conditional-export check all passed.
- Cloudflare Worker build run #1502: success. Wrangler target validation and build completed; the workflow did not deploy.
- Devnet lifecycle validation run #1569: success. The real read-only cluster identity/RPC check passed. The funded lifecycle job was skipped, as required without explicit opt-in.
- External Deno Deploy status `deploy/hesamtanya75-stack/solana-smart-bot-17`: failure. The GitHub status points to the Deno Deploy console; this status alone does not identify a source-code failure or expose a diagnostic log.

Code review of the current coordinator confirms it still requires a trusted all-in cost record and `semanticInstructionVerification === true` plus `routeVerification === "semantically-verified"` before reservation. The current quote-only evidence path does not supply an executable transaction or semantic CPI proof. The coordinator therefore remains fail-closed; do not manufacture cost or route evidence to make tests pass.

The simulation balance helper remains a diagnostic normalizer. It does not authenticate token-account state, remote simulation identity, CPI effects, or all-in native SOL costs. Finalized settlement checks verify owner-scoped token deltas but explicitly leave whole-message semantic verification and all-in cost verification false.

PR #56 remains open and Draft. No merge, production deployment, wallet signing, transaction submission, funded Devnet lifecycle, or Mainnet trading has been performed.


## Validation checkpoint — 2026-11-21 (head e48ffcc)

The latest PR #56 head `e48ffcc78eaf509c3b5e04130c015aae16792b60` completed the following GitHub Actions validations:

- Node tests run #1997: success. All 478 tests passed, including the isolated Durable Objects runtime, dependency audit gate, and ATA SDK workerd conditional-export check.
- Cloudflare Worker build validation run #1503: success. Wrangler target validation and Worker build passed; no deployment was performed.
- Devnet signed lifecycle validation run #1570: success. The read-only preflight confirmed the Devnet genesis hash and RPC health. Signing was not performed and zero transactions were submitted. The funded Devnet lifecycle job was skipped because explicit workflow-dispatch opt-in was not supplied.
- The Devnet preflight could not validate holder concentration: the public RPC rate-limited holder enumeration. Holder metrics were null and the output explicitly warned that this was not a complete holder census or token-safety verdict.
- External Deno Deploy status `deploy/hesamtanya75-stack/solana-smart-bot-17` remains failure. The GitHub commit-status API reports the explicit description `Organization suspended - resolve billing to deploy`; this identifies an organization billing/suspension blocker, not evidence of a Worker source-code failure. Deployment remains blocked until the organization billing/suspension state is resolved.

These checks validate tests, a non-deploying Worker build, and read-only Devnet connectivity only. They do not close the semantic CPI, complete value-flow, or all-in cost release blockers described above. PR #56 remains open and Draft. No merge, production deployment, wallet signing, transaction submission, funded Devnet lifecycle, or Mainnet trading has been performed.


## Deno Deploy status diagnosis — 2026-11-21

A direct read of the GitHub commit status for head `ec546d2bb1d9630d03f801ac6f48cd6e6c47ef83` returned status context `deploy/hesamtanya75-stack/solana-smart-bot-17`, state `failure`, and the explicit provider description `Organization suspended - resolve billing to deploy`. The linked provider target is the Deno Deploy console. This is an organization billing/suspension blocker; it is not evidence that the Worker build or source code failed. The Cloudflare Worker build validation on the same head passed without deploying.

Resolution requires an authorized organization owner/admin to review and resolve the billing/suspension state in Deno Deploy. No billing change, deployment, or external account action was attempted from this workflow. Do not bypass the failed deployment status or treat it as resolved until the provider reports success.
