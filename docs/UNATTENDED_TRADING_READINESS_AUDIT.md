# Unattended trading readiness audit

Audit basis: branch `manual-live-wallet-connect-synced-4678a20`, commit `0f537faa632f36728854d9835d5d34d171e84f52`, PR #40. This is a source and CI review, not a live transaction test.

## Verified CI at the audited commit

- Node test workflow: completed successfully.
- Cloudflare Worker build validation: completed successfully.
- Devnet read-only workflow: completed successfully.
- Funded Devnet lifecycle job: skipped. No funded signed transfer was tested.
- PR #40 remains open and draft; it has not been merged.

## Verified implementation state

| Area | Observed state | Readiness |
| --- | --- | --- |
| Phantom browser connection | Public key and balance read-only; no browser signing/submission methods in the reviewed flow | Read-only only |
| Worker live API | No `/api/live` route found; Worker does not instantiate or call the live coordinator | Not integrated |
| Live order retrieval | Jupiter unsigned order/build evidence can be retrieved | Not execution-ready |
| Transaction semantics | Evidence explicitly reports `semanticInstructionVerification: false` and `routeVerification: "build-envelope-only"` or `"unsigned-structure-and-alt-only"` | Blocking |
| Signing and submission | `executeLiveOrder()` deliberately throws that live execution is not implemented | Not implemented |
| Coordinator reservation | Applies trusted evidence, spend/position caps, idempotency, kill-switch checks and reservation state | Isolated primitive only |
| Settlement | Confirmation expects independent finalized proof; failure and close proof transitions explicitly remain disabled | Incomplete |
| Wallet identity | Code pins `EXPECTED_BOT_WALLET`; current login session is not a fully enrolled, stable wallet principal | Incomplete |
| Funded Devnet lifecycle | Workflow is opt-in and was skipped in the observed run | Not tested |

## Release blockers, in dependency order

1. **Wallet custody and principal binding:** choose a dedicated trading wallet and isolated signer model; define enrollment, authorization, rotation, revocation, and recovery. Do not reuse a primary Phantom wallet or put seed phrases/private keys in browser storage, Worker variables, KV, Durable Objects, logs, or source.
2. **Semantic transaction verification:** decode the complete transaction, resolve lookup tables, and validate every instruction, account, signer, writable privilege, destination, token movement, fee, rent, tip, and program against a reviewed policy. Reject unknown or unsupported instructions.
3. **Immutable order intent and signer enforcement:** bind exact wallet, cluster, input/output mints, amount, minimum output, slippage, fees, expiry, and idempotency to one intent. The isolated signer must independently enforce policy and sign only that intent.
4. **Submission and ambiguity handling:** implement single-submit semantics, signature reconciliation, replay protection, and no blind replacement transaction after an ambiguous RPC response.
5. **Complete settlement and state machine:** independently verify finalized owner-scoped token/SOL deltas and all-in costs; implement independently provable failed/closed transitions and recovery from interrupted states.
6. **Strategy and loss controls:** explicitly configure buy/sell rules, per-order and daily spend, total exposure, open positions, daily loss, liquidity, volume, slippage, price impact, token checks, allowlists, and emergency-stop behavior. No permissive defaults.
7. **Non-production end-to-end validation:** test the exact buy and sell paths with a disposable Devnet wallet and explicit opt-in; inject RPC, quote, signer, duplicate cron, partial submission, rate-limit, and settlement failures.
8. **Independent review and release authorization:** review the threat model, signer isolation, operational alerts, emergency stop, rollback, and all acceptance tests before any separate Mainnet release decision.

## Safety boundary

Passing CI does not prove live-trading readiness. Connecting Phantom does not provide unattended signing. This audit makes no live route, signer, transaction submission, production deployment, merge, Cloudflare binding, KV, or Durable Object changes. Mainnet trading must remain disabled. No real transaction was signed or submitted as part of this audit.


## Follow-up verification: PR head `4108d6b59fded78826634b70a5d0206b61b86eff`

The following workflows completed successfully for this exact commit:

- Node tests: success.
- Cloudflare Worker build validation: success; the workflow only builds and does not deploy.
- Devnet signed lifecycle workflow's read-only job: success.
- The separate `funded-devnet-lifecycle` job: skipped because it requires an explicit `workflow_dispatch` opt-in. No funded signing or transfer was performed by this PR run.

Important test-coverage limitation: coordinator unit tests can supply a mocked trusted-evidence fixture with `semanticInstructionVerification: true` and `routeVerification: "semantically-verified"` to exercise downstream reservation policy. This does not implement or prove a real transaction semantic decoder. The actual Jupiter transaction parser tests continue to assert `semanticInstructionVerification: false`, including for structurally parsed unknown programs. The coordinator's production gate remains fail-closed.

The README also confirms that the Worker has no live-trading route invoking the coordinator and that the current Worker does not submit real transactions.


## Latest CI verification: commit `6ba96b3ad3bc2166ab944d3dc2a7e20e741309a5`

The latest PR head was rechecked. The following results are confirmed for this exact commit:

- Node tests: success (workflow run 44289753571).
- Cloudflare Worker build validation: success (workflow run 44289753686); the job explicitly ran a build without deploying.
- Devnet read-only validation: success (job 134751587594).
- Funded Devnet lifecycle: skipped (job 134752045402); no funded signing or transfer occurred.

## Latest source-level fail-closed confirmation

- `live-trading.mjs` returns `semanticInstructionVerification: false` and `routeVerification: "unsigned-structure-and-alt-only"` for the currently parsed transaction evidence.
- `executeLiveOrder()` throws `Live execution is not implemented; no transaction was signed or submitted`.
- `trusted-live-evidence.mjs` returns `semanticInstructionVerification: false` and `routeVerification: "build-envelope-only"` for build-envelope evidence.
- `live-trade-coordinator.mjs` blocks reservation unless the risk evidence explicitly carries `semanticInstructionVerification: true` and `routeVerification: "semantically-verified"`.
- The coordinator still pins a hardcoded bot wallet, and the Worker has no live execution route invoking it.

These are intentional blockers, not successful live-trading functionality. The latest CI validates the current tests and build, not semantic transaction verification, unattended signing, or live execution.


## Follow-up CI result for audit commit `bd23ea165788d673355c39796d833aaec225dcce`

All three workflow runs for this exact commit have now completed:

- Node tests: success (run 44290014681; safety and Durable Objects runtime test step passed).
- Cloudflare Worker build validation: success (run 44290014476; Wrangler target verification and "Build Worker without deploying" passed).
- Devnet workflow: success (run 44290014811), consisting of the read-only Devnet job only.
- Funded Devnet lifecycle: skipped (job 134752045402). No funded transfer or signing test was performed.

## Scope decision

No transaction-decoder implementation was added in this follow-up. The existing parser remains structural-only and explicitly marks semantic verification false; unknown instruction programs are structurally parsed but are never semantically trusted. The next implementation must begin with a versioned, exact instruction/program allowlist and reviewed decoders, then prove account/value matching and full funds-flow reconstruction with negative tests. Do not relax coordinator gates to make mocked fixtures pass as production evidence.


## CI verification for instruction-slot fail-closed test commit `bf269296ad893fb5211b3c6acabec93744ba23e9`

All workflows for this exact commit completed successfully:

- Node tests: success (run 44291310641), including the safety and Durable Objects runtime test suite containing the new Jupiter instruction-slot test.
- Cloudflare Worker build validation: success (run 44291310708); Wrangler target verification passed and the Worker was built without deployment.
- Devnet workflow: read-only job success (run 44291310800).
- Funded Devnet lifecycle: skipped. The workflow explicitly reported it as skipped without opt-in; no funded transaction or signing test was performed.

The new test confirms the current /build envelope validator does not promote any of the six instruction slots (compute budget, setup, swap, cleanup, other, tip) to semantic trust merely because an instruction is present or uses a familiar program ID. It does not implement semantic decoding.


## CI confirmation for audit head `066f9ac13bb499b7143be86668bb70acd0cd8227`

All workflows associated with this exact commit completed:

- Node tests: success (run 44291592659); the safety and Durable Objects runtime test step passed.
- Cloudflare Worker build validation: success (run 44291592761); Wrangler target verification passed and the Worker was built without deploying.
- Devnet read-only job: success (run 44291592972); cluster identity and read-only RPC checks passed.
- Funded Devnet lifecycle: skipped. The workflow explicitly reported that funded lifecycle was skipped without opt-in. No funded signing or transfer test was run.

## Decoder implementation boundary

A source review of `trusted-live-evidence.mjs`, `live-trading.mjs`, and `tests/trusted-live-evidence.test.mjs` confirms the parser still performs structural transaction parsing and ALT resolution only. The tests cover malformed encodings, duplicate keys, lookup-table integrity, signer/account-index constraints, and explicit non-trust for unknown programs and all six Jupiter build instruction slots. They do not yet decode and semantically verify System, Compute Budget, SPL Token/Token-2022, Associated Token Account, or Jupiter router instructions.

The live execution function still throws that execution is not implemented. The pinned wallet constant remains in the live-trading module; per-user dedicated-wallet enrollment and signer isolation are not implemented. Do not describe these controls as complete.

Next safe engineering stage: add a versioned instruction decoder registry that defaults to reject-all, then implement and test one instruction family at a time against the immutable transaction intent. Keep semantic trust false, coordinator gates closed, and live execution non-executing until the full acceptance gate in the semantic verification plan is met.


## Latest PR #40 head verification: `d15f81a0d843f5227e35d4b4995106f9c63f4e2e`

PR metadata and workflow runs were checked against the current head:

- PR #40 remains open and Draft, not merged; head is `d15f81a0d843f5227e35d4b4995106f9c63f4e2e`, base is `security/pr26-clean-main`.
- Node tests: success (run 44291821525; test job passed).
- Cloudflare Worker build validation: success (run 44291821402; validation/build job passed; no deployment).
- Devnet workflow: read-only job success (run 44291821573).
- Funded Devnet lifecycle: skipped. No funded signing or transfer was run.

## Remaining work — readiness checklist

The following are still blockers for unattended live trading; passing CI does not complete them:

1. **Semantic transaction verification:** implement reviewed, versioned decoders for each explicitly supported instruction family (System, Compute Budget, SPL Token/Token-2022, Associated Token Account, and Jupiter/router paths); reconstruct all-in funds flow and bind the complete message to immutable server-side intent. Unknown or unsupported instructions must remain rejected.
2. **Dedicated wallet enrollment:** replace the single hardcoded wallet assumption with an authenticated per-user enrollment model for a separate trading wallet. Establish proof-of-control without collecting seed phrases/private keys; do not migrate production sessions/KV without a separate migration plan and approval.
3. **Isolated signer:** implement a separately secured signer service that independently revalidates the exact transaction, wallet, cluster, intent, limits, and expiry before signing. Phantom browser connection alone is read-only and is not unattended signing.
4. **Worker integration and identity:** add stable authenticated principal identity and scoped wallet/policy ownership; wire a live coordinator route only after the verifier and signer exist. Currently the Worker session stores only `expiresAt`, and exporting the Durable Object class does not itself wire a live route.
5. **Complete lifecycle and settlement:** safely handle submit, timeout/ambiguous result, finalized confirmation, failure, cancellation/expiry, close/exit, reconciliation, and idempotent replay. The current coordinator's confirmation path expects finalized proof; the other transitions are not a complete trading lifecycle.
6. **Trading policy:** define explicit entry/exit strategy and enforce per-order/daily spend, total exposure, open positions, daily loss, slippage, price impact, quote freshness, liquidity/volume, token authority/extensions, holder concentration, and sell-route rules.
7. **Operational controls:** add emergency stop, monitoring/alerts, durable audit trail, signer key rotation/recovery, incident response, and independent security review.
8. **Release validation:** only after the above, run isolated disposable-wallet Devnet signing/transfer tests with explicit authorization, then a separate Mainnet readiness/security review and explicit release approval.

Current safe status remains paper-trading / no real transaction submission. Do not merge, deploy, enable Mainnet, or run funded Devnet as part of this audit.
