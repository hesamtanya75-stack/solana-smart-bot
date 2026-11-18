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


## CI completion for readiness-checklist commit `458a535a95366b0417a804583da0e35e2d685ab8`

The three workflows for this exact PR head have completed:

- Node tests: success (run 44292138720; test job passed).
- Cloudflare Worker build validation: success (run 44292138818; Worker validation/build job passed without deployment).
- Devnet workflow: success (run 44292138776; read-only job passed).
- Funded Devnet lifecycle: skipped. No funded signing or transfer test was run.

This validates the repository test suite and build for this commit only. It does not implement or validate semantic transaction decoding, unattended signing, or live trading.


## CI completion for audit update commit `aa7a96a33cbb08eba425684398e450fd76bd5907`

All three PR-triggered workflow runs for this exact head completed:

- Node tests: success (run 44292513992; test job passed, including safety and Durable Objects runtime tests).
- Cloudflare Worker build validation: success (run 44292514006; Wrangler target verification and build-without-deploy passed).
- Devnet workflow: success (run 44292516113; read-only Devnet validation passed).
- Funded Devnet lifecycle: skipped (job 134761573407). No funded signing or transfer was performed.

PR #40 remains open and Draft, not merged. This CI result validates tests, build, and read-only Devnet checks only. It does not establish semantic transaction verification, wallet enrollment, isolated signing, transaction submission, settlement, or unattended live-trading readiness. The existing safety boundary remains unchanged: no merge, production deploy, funded Devnet run, or Mainnet trading.


## CI completion for decoder-plan commit `d4c789ba4ba34f239d8c7bec371975eafcf4aff6`

All PR-triggered workflows for this exact head completed:

- Node tests: success (run 44293522543; test job passed).
- Cloudflare Worker build validation: success (run 44293522532; build validation passed without deployment).
- Devnet workflow: success (run 44293522533; read-only Devnet job passed).
- Funded Devnet lifecycle: skipped (job 134764962922). No funded signing or transfer was performed.

This validates the repository tests, Worker build, and read-only Devnet checks for this documentation-only commit. It does not implement a decoder registry or instruction decoders, and does not validate signing, transaction submission, settlement, or live trading. PR #40 remains Draft and unmerged; no production deployment or Mainnet trading is authorized by this result.


## Current readiness review — PR #40 head `06b332995050b29f471739614ea4bcb456e97c7b`

This review was performed after adding the analysis-only transaction instruction parser and its negative tests.

### CI evidence for this exact head

- Node tests: success.
- Cloudflare Worker build validation: success; this is a build/validation result, not a deployment.
- Devnet read-only validation: success.
- Funded Devnet lifecycle: skipped; no funded signing or transfer was performed.
- PR #40 remains open and Draft; it is not merged.

### Source state confirmed

- `transaction-instruction-parser.mjs` accepts a bounded, already-deserialized message and currently recognizes only the registered Compute Budget instruction family.
- System Program, SPL Token, Token-2022, Associated Token Account, and Jupiter/router instructions remain unsupported and are rejected. The parser explicitly reports incomplete semantics and disallows signing/submission.
- `live-trading.mjs` retrieves unsigned Jupiter order evidence only. It explicitly reports semantic verification false and `executeLiveOrder()` throws that live execution is not implemented.
- `live-trade-coordinator.mjs` requires semantic verification and route verification attestations before reservation. The current evidence producer does not provide those attestations, so the gate correctly remains closed.
- The Worker has no live execution route invoking the coordinator.
- The wallet model remains a hardcoded expected public key, not a principal-scoped dedicated-wallet enrollment and isolated signer.
- Settlement failure/close transitions remain disabled pending independent proofs.

### Mainnet release decision

**NO-GO — do not enable real-money trading.** Successful Node tests, Worker build, and read-only Devnet checks do not prove transaction semantics, signing security, submission correctness, or finalized settlement.

The following gates must be completed in order before a separate Mainnet release review:

1. Implement and independently review complete legacy/v0 message decoding, including address lookup table resolution and account signer/writable privileges.
2. Implement versioned, reject-by-default semantic decoders for each supported instruction family: System, Compute Budget, SPL Token, Token-2022, Associated Token Account, and the exact Jupiter/router programs and CPI paths. Reject every unrecognized variant.
3. Reconstruct the complete SOL/token funds flow, including input/output amounts, base and priority fees, tips, rent, WSOL wrapping/unwrapping, account creation/closure, and every other debit/credit; bind it to an immutable, short-lived server-side order intent.
4. Implement a stable authenticated principal and dedicated trading-wallet enrollment/revocation model. Keep the primary Phantom wallet separate. Never collect or store seed phrases/private keys in the browser, Worker, KV, Durable Objects, or repository.
5. Implement a separately isolated signer that independently checks principal, wallet, cluster, exact intent, transaction bytes, limits, expiry, and idempotency. The signer must not expose general-purpose signing.
6. Implement one-time wallet-control proof and step-up MFA for enrollment and policy changes; wallet proof must not itself authorize trades.
7. Implement safe one-time submission, signature reconciliation after ambiguous RPC results, finalized settlement, and independently provable failure/close/cancel transitions.
8. Complete buy/sell policy and loss controls: per-order/daily spend, total exposure, open positions, daily loss, slippage, price impact, quote age, liquidity, volume, mint/freeze authorities, Token-2022 extensions, holder concentration, sell-route, and allow/deny lists.
9. Add durable audit/alerts, emergency stop, key rotation/recovery, failure injection, and independent security review.
10. Run the complete buy and sell lifecycle on a disposable funded Devnet wallet only after explicit opt-in. Then conduct a separate Mainnet readiness review and require explicit release authorization.

Until every gate is independently verified, keep live trading disabled, the coordinator disconnected from Worker execution routes, and the existing paper-trading path unchanged. Do not merge PR #40, deploy to production, fund a wallet for testing, or submit any Mainnet transaction as part of this preparation.


## Follow-up review: API throttling and exact-head CI evidence

At commit `2b1684224bbc31e6db3f0b266b8ccc7061b21181`, the API rate-limit implementation was reviewed in `worker.js` and `auth-guard.mjs`. Route-class and authentication-specific limits are enforced through transactional Durable Object state; IP addresses are hashed into bucket scopes; unavailable rate-limit enforcement fails closed; and the number of retained rate-limit buckets is bounded at 1,000. The corresponding tests cover concurrent consumption, expiry, malformed persisted state, and capacity exhaustion.

**Residual operational risk:** throttling is still primarily IP-and-route scoped rather than principal/session scoped. A distributed source-IP population can consume the bounded bucket capacity and throttle new sources. This is not a confirmed exploit, but it is an unresolved resilience/fairness concern before wallet enrollment or unattended trading. Preserve fail-closed behavior; add a separately reviewed principal/session-aware layer and multi-IP load tests before considering this gate complete.

### CI evidence for exact reviewed commit

- Node tests: success (run 44310212630).
- Cloudflare Worker build validation: success (run 44310212665); build only, no deployment.
- Devnet read-only validation: success (run 44310212609).
- Funded Devnet lifecycle: skipped because explicit opt-in was not supplied; no funded signing or transfer was performed.
- PR #40: open, Draft, not merged.

These checks do not validate full transaction semantics, wallet enrollment, isolated signing, submission, or Mainnet readiness. Keep live execution disabled and paper trading unchanged.


## Follow-up review: bearer-session and wallet identity boundary

Reviewed `worker.js` session authorization, login/MFA completion, logout, same-origin checks, and the private API router at the current PR head.

- Private `/api/*` routes share a session guard before route handlers; unknown private API paths do not bypass it. State-changing API requests are checked for same-origin signals before route handling. Dedicated login/TOTP and private API rate limits are applied, and rate-limit service failure returns 503.
- A successful password-only login (when TOTP is not enabled) or successful MFA challenge creates a random UUID bearer token. The Workers KV session record contains only `expiresAt` and expires after 12 hours. Each private request checks that the token has the expected UUID shape and that the stored expiry is in the future. Logout deletes that token's KV record.
- The reviewed Worker session record does not bind a stable authenticated principal, enrolled wallet, authorization version, or step-up authentication state. The API uses an Authorization Bearer token rather than a server-managed Secure/HttpOnly cookie. Therefore the current session model is not yet an adequate identity/authorization foundation for dedicated-wallet enrollment or unattended signing. A browser-readable bearer token is exposed to same-origin script execution if an XSS flaw is ever introduced; this review does not establish that an exploitable XSS currently exists.
- Same-origin request checks are a useful CSRF defense for browser mutation requests, but they do not replace session identity, wallet binding, reauthentication, or signer-side policy enforcement.

**Required before wallet enrollment or unattended trading:** introduce a reviewed server-managed session design (Secure, HttpOnly, SameSite cookie with explicit CSRF protection, or an equivalently hardened approach), stable principal/session identifiers and revocation/versioning, short-lived step-up authorization for wallet/policy changes, and explicit binding to a separately enrolled trading wallet. The isolated signer must independently verify those bindings on every intent. Preserve current fail-closed route behavior; do not add a signing or submission route as part of this hardening checkpoint.

This is a source-review gap, not a confirmed account compromise. Keep Phantom read-only, primary wallet separate, live execution disabled, and paper trading unchanged.


## Follow-up review: TOTP enrollment, MFA challenges, and recovery code

Reviewed the exact PR head `7b06a5a094d80bc8e87bd558e9fb457fe1e437d9` in `worker.js`, `auth-guard.mjs`, `tests/worker-auth-routes.test.mjs`, and `tests/auth-guard.test.mjs`.

- TOTP setup and confirmation are inside the shared authenticated private API router. Setup additionally requires the current admin password, applies route-specific and failure-scope limits, and stores the pending secret through the transactional AuthGuard. Confirmation is separately rate-limited and checks a six-digit code against a pending secret whose lifetime is limited to ten minutes.
- AuthGuard confirmation checks the pending timestamp again inside its transaction, enforces the failure threshold atomically, stores the accepted TOTP counter, enables TOTP, and clears the pending secret. This prevents a stale/future pending timestamp or replayed counter from being accepted by the state transition.
- MFA login challenges expire after five minutes, are bounded in number, and have atomic attempt limits. Successful TOTP completion advances the accepted counter; successful backup-code completion consumes the one stored backup hash and deletes the challenge. Tests cover expiry, concurrent attempts, replay/counter acceptance, and one-time backup consumption.
- The backup code is generated at confirmation and returned once; only its hash is retained in AuthGuard state. The reviewed implementation stores a single recovery code, not a multi-code recovery set.

**Remaining hardening before unattended trading:** retain the separate session-identity gap documented above; add integration-level tests for the complete Worker routes (not only AuthGuard unit tests), explicit logout/session revocation and session expiry tests, and a recovery procedure for loss of the sole backup code that does not weaken authentication. Ensure operational recovery cannot silently disable MFA or rebind the trading wallet. No confirmed TOTP bypass was identified in this source review.

This checkpoint is documentation-only. Do not change the UI, enable wallet signing, or add transaction submission.
