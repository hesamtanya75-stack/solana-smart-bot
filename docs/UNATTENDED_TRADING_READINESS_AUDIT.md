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
