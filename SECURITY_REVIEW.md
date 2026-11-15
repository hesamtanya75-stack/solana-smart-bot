# Security review — PR #27

Historical review baseline: `security/pr26-clean-main` at commit `75b0f0633f1445362caef68b5541b688632ef5f1`. The latest branch-head verification is recorded in the dated addendum at the end of this file.

## Decision

**NOT APPROVED for Mainnet, signing, transaction submission, or live trading.** This branch remains a paper-trading and security-preparation change. Keep PR #27 in Draft. No merge or production deployment is authorized by this review.

## Current implementation verified

- Paper-trading state is stored in the `PaperTradingState` Durable Object and updated with revision-based compare-and-set operations.
- Authentication state, TOTP counters, backup-code consumption, MFA challenges, and failure buckets are serialized through the `AuthGuard` Durable Object.
- AuthGuard requires an internal Bearer token of at least 32 characters, limits MFA challenges to five minutes and five attempts, and consumes backup codes atomically.
- The Worker enforces same-origin signals for mutating API requests and validates session identifiers before KV lookup.
- The live coordinator obtains SOL/USD and token-risk evidence through trusted server-side code. Browser-supplied quote timestamps, quote IDs, SOL/USD prices, and risk booleans are ignored.
- The latest paper scanner change selects only Solana DexScreener pairs whose `baseToken.address` exactly matches the requested mint.
- RPC response parsing now rejects mismatched IDs, missing results, malformed batch items, and duplicate or missing batch IDs.
- Follow-up hardening in commits `98d1c0f` and `b727605` restricts the root-directory static-assets fallback to `/` and `/index.html`, preventing repository source modules, tests, documentation, and configuration files from being served as static assets; a regression assertion covers this allowlist.
- CI on this commit passed Node tests, frontend syntax validation, and Cloudflare Worker dry-run build validation. Devnet read-only checks passed. The funded signed Devnet transfer step was skipped because `DEVNET_RPC_URL` was not configured.

## Findings blocking any live-trading use

### Critical — no end-to-end live-trade path

The Worker does not call `LiveTradeCoordinator`. There is no production route that reserves, signs, submits, or reconciles a live order. `executeLiveOrder()` deliberately throws. No transaction is signed or submitted.

### High — sell-route verification makes reservations fail closed

`fetchTrustedSellRoute()` requires the expected bot wallet to already own enough of the output token to run a $3 sell probe. That condition normally cannot hold before the first purchase of a new token. In addition, `validateUnsignedJupiterTransaction()` validates transaction wire structure only and explicitly returns `semanticInstructionVerification: false`. The risk evidence consequently cannot satisfy the coordinator's requirement for semantic instruction verification. **Reservations are currently blocked by design.** Do not weaken these checks. A future implementation needs a safe, independently verified exit-route simulation and full instruction/account/program and address-lookup-table decoding.

### High — settlement transitions are disabled

The coordinator's `transition()` method always rejects because independent on-chain settlement proof is not implemented. Confirm, close, and failure transitions cannot safely update state or release capacity. A future reconciler must verify transaction signatures and finalized chain state, or cryptographically establish non-submission, before changing reservation status.

### High — coordinator is isolated and has no trusted caller

The coordinator requires `COORDINATOR_INTERNAL_TOKEN`; the Worker does not call it and the Wrangler file does not configure that secret. This is fail-closed. Any future integration must use a dedicated secret, enforce operator authorization for kill-switch changes, and keep the coordinator inaccessible to browser-controlled requests. Do not expose a public coordinator route.

### High — no funded signed Devnet lifecycle test

The current workflow ran unit/runtime tests and read-only Devnet checks, but skipped the ephemeral signing and faucet-funded transfer step because `DEVNET_RPC_URL` was absent. The workflow's overall success must not be described as proof that a signed transfer or transaction lifecycle was tested.

### Medium — holder concentration and market feeds remain bounded evidence

Trusted live evidence requires paginated Alchemy token-account data and reconciles holder balances to supply before considering concentration. Missing or incomplete data fails closed. DexScreener and RugCheck remain external signals, not proof of safe liquidity, fair price, ownership, or executable exit liquidity. The scanner's top-account concentration estimate in the paper-trading path must not be represented as a complete wallet-level holder census.

### Medium — reservation history is capped but still requires an archival design

The coordinator now enforces `MAX_RESERVATIONS = 1000` and rejects new reservations at capacity without deleting historical idempotency records. A regression test verifies the capacity guard and preserves duplicate-request handling. This bounds growth and fails closed, but it is not a complete long-term retention solution: before any live integration, design and test an indexed/archival strategy with safe idempotency retention, migration, recovery, and long-running growth behavior.

## Authentication review

The reviewed AuthGuard implementation serializes state changes transactionally. Concurrent tests cover one-time backup-code use, one-time TOTP counter acceptance, MFA challenge completion, attempt limits, bounded failure buckets, and one-time legacy initialization. The internal endpoint rejects missing or malformed Bearer credentials and oversized bodies. Runtime secrets and bindings in the deployed Cloudflare environment have not been independently inspected; repository configuration alone does not prove that production secrets are present or correct.

## Deployment and configuration boundary

The checked-in Wrangler configuration declares KV `BOT_STATE`, Durable Objects `LIVE_TRADE_COORDINATOR`, `AUTH_GUARD`, and `PAPER_TRADING_STATE`, plus their migration tags and the `ASSETS` binding. CI validates the configuration and performs a dry-run build only. It does not inspect live Cloudflare account settings or prove that production secrets, namespace bindings, migrations, or cron settings are correctly applied.

## Release gate

Do not merge this PR or enable Mainnet/live trading. Before any separate live-trading proposal, resolve the blocking findings above, verify deployed Cloudflare configuration without exposing secret values, run a dedicated Devnet-only signed lifecycle test with a disposable wallet, test recovery and ambiguous submissions, and obtain independent review of transaction decoding, signing, submission, and settlement reconciliation. Any Mainnet enablement requires separate explicit user approval.


## Review update — 2026-11-15

The earlier review target above is historical. The current code review was refreshed against branch `security/pr26-clean-main` at code commit `a55a90110c93c8beaf9f3a71671b641642207a48`. This documentation update does not change application code.

### Additional hardening verified on the refreshed code

- Static asset requests are configured with `run_worker_first: true`, so requests pass through the Worker before assets can be served. The Worker fallback permits only `/` and `/index.html`; other static paths return 404. A regression test covers the allowlist.
- The dashboard's Token Program field now escapes RPC-derived program-owner metadata before HTML rendering. A regression test checks the safe rendering expression in `index.html`.
- The latest test run completed **103 tests: 103 passed, 0 failed, 0 skipped**.
- Cloudflare Preview reported Build Success and Deployment Success for this code revision. The Preview URL could not be independently reached for runtime verification, so this is not evidence of end-to-end runtime behavior.
- The Devnet workflow's signed/funded transfer step remains skipped because `DEVNET_RPC_URL` is not configured. Read-only Devnet checks and local/runtime tests do not prove a signed transaction lifecycle.

### Outstanding CI and release warnings

- The test job installs Miniflare with `npm install --no-save --ignore-scripts --package-lock=false miniflare@3`. npm reported **5 high-severity vulnerabilities** in the temporary 64-package install. The job log did not include the detailed audit report, so affected packages, advisories, reachability, and remediation are not yet established. Do not run `npm audit fix --force` or claim this warning is resolved without identifying the advisories and validating a compatible fix.
- A legacy Deno Deploy integration status remains failed. The project has moved to Cloudflare; this status is not proof of a Cloudflare Preview failure, but it remains an unresolved repository status check.
- The Preview deployment result does not verify live Cloudflare production secrets, KV namespace bindings, Durable Object migrations, or cron configuration. Those remain outside this repository-only review.

### Refreshed decision

**Still NOT APPROVED for Mainnet, signing, transaction submission, or live trading.** Keep PR #27 in Draft. Do not merge or deploy to production. Paper-trading and the successful CI test suite do not establish live-trading readiness. The blocking findings above, the missing funded Devnet lifecycle test, and the outstanding dependency audit must be addressed in a separately reviewed change before any release decision.


## CI review update — 2026-11-15 (commit 67b0e6f0ffb86a1db5342fc363e058d09c397dd6)

This update supersedes the earlier dependency-audit warning for the exact commit named above; it does not erase the historical findings recorded above.

### Verified GitHub Actions results for this commit

- Node tests: **103 tests, 103 passed, 0 failed**.
- npm audit for the isolated Miniflare test dependency installation: **0 vulnerabilities reported**.
- Cloudflare Worker build validation: **success** (Wrangler dry-run validation; not a production deployment).
- Frontend syntax validation: **success**.
- Devnet read-only cluster/RPC validation: **success**.
- Funded signed Devnet transfer: **skipped**, because `DEVNET_RPC_URL` was not configured. No signed Devnet transaction lifecycle is claimed.
- The workflow job completed successfully; this does not prove production Cloudflare secrets, bindings, migrations, or runtime behavior.

### Current release decision

The successful tests and clean npm audit resolve the specific CI test-runtime audit warning for this commit. They do **not** resolve the live-trading blockers documented above. Keep PR #27 in Draft. No merge, production deployment, Mainnet signing, transaction submission, or live trading is approved. The funded Devnet lifecycle and independent review of live transaction decoding and settlement remain outstanding.


## CI review update — 2026-11-15 (documentation commit deada9618c20590c859dbed4292610fc327f9be3)

The security-review documentation was refreshed after the CI results for application-code commit `67b0e6f0ffb86a1db5342fc363e058d09c397dd6` had been recorded. The documentation-only commit `deada9618c20590c859dbed4292610fc327f9be3` was then independently checked by GitHub Actions:

- Node tests: **103 passed, 0 failed**.
- npm audit for the isolated Miniflare test dependency installation: **0 vulnerabilities reported**.
- Cloudflare Worker build validation: **success** (Wrangler dry-run; no deployment).
- Frontend validation: **success**.
- Devnet read-only validation: **success**.
- Funded signed Devnet transfer: **skipped** because `DEVNET_RPC_URL` is not configured.

This documentation-only commit does not change application behavior and does not resolve the previously recorded live-trading blockers. A source review of the current branch confirms the coordinator remains uncalled by the public Worker, its internal secret is not configured in checked-in Wrangler configuration, semantic Jupiter instruction/address-lookup verification is explicitly false, and settlement transitions remain disabled. The funded Devnet lifecycle and independent verification of deployed Cloudflare secrets, bindings, migrations, and cron remain outstanding.

**Release decision unchanged:** PR #27 remains Draft. No merge, production deployment, Mainnet signing, transaction submission, or live trading is approved.


## CI and source-review update — 2026-11-15 (branch head 204ed569fac242c3a6495d4fc6c37c758f593d88)

The documentation-only commit above was checked against the current branch head. All five GitHub check runs completed successfully:

- JavaScript syntax validation: success.
- Node test job: success; the isolated Miniflare dependency audit enforcement step and the safety/Durable Objects runtime test step both passed.
- Devnet read-only job: success; the Devnet identity and read-only RPC validation step passed.
- Funded signed Devnet transfer: **skipped**, because `DEVNET_RPC_URL` was not configured. The workflow explicitly reported the lifecycle test as skipped; no signed transfer is claimed.
- Cloudflare Worker validation: success; Wrangler build without deploying passed.
- Cloudflare Workers Preview Build check: success. This is a Preview build result, not a production deployment or proof of deployed runtime configuration.

The current source was also rechecked. The Worker still does not call the Durable Object live coordinator; the coordinator's reservation path requires semantic instruction and lookup-table verification that the current transaction parser does not provide; settlement transitions still reject because independent on-chain proof is not implemented; and `executeLiveOrder()` still throws without signing or submitting. The coordinator remains fail-closed and is not an end-to-end live-trading path.

The earlier dependency-audit warning was superseded for commit `67b0e6f0ffb86a1db5342fc363e058d09c397dd6` by a clean isolated audit, and the current branch-head audit-enforcement step passed again. Historical warnings above are retained as history, not current claims of an unresolved audit finding.

**Current release decision: unchanged.** PR #27 remains Draft and unmerged. Do not merge, deploy to production, sign or submit Mainnet transactions, or enable live trading. Remaining gates include full semantic Jupiter instruction/account and address-lookup-table verification, independent settlement/recovery design, an authenticated emergency-stop integration, bounded reservation retention, a funded signed Devnet lifecycle test using a disposable wallet, and independent review of any future signing/submission implementation. Production Cloudflare secrets, bindings, migrations, and cron settings have not been independently inspected.


## CI completion update — 2026-11-15 (documentation commit b76ef1c5d287a364770b644977e31d17d03295a8)

GitHub checks for the documentation commit completed:

- JavaScript syntax: success.
- Node test job: success, including isolated dependency audit enforcement and safety/Durable Objects runtime tests.
- Devnet read-only job: success, including cluster identity and read-only RPC validation.
- Cloudflare Worker validation: success; Wrangler build ran without deployment.
- Cloudflare Workers Preview Build: success.
- Funded signed Devnet transfer: **skipped** because `DEVNET_RPC_URL` was not configured. The successful read-only job is not a signed transaction lifecycle test.

This commit changes documentation only. It does not remove the transaction semantic-decoding, lookup-table, settlement, emergency-stop, reservation-retention, funded Devnet lifecycle, or production-configuration verification gates. PR #27 remains open, Draft, and unmerged. No production deployment or Mainnet activity is approved.


## CI completion and source re-review — 2026-11-15 (documentation commit 1c0a7181530b028ef393c39c8e4ac6ca9a0444e4)

GitHub Actions for documentation commit `1c0a7181530b028ef393c39c8e4ac6ca9a0444e4` completed with all five check runs successful:

- JavaScript syntax validation: success.
- Node test job: success.
- Cloudflare Worker validation: success (dry-run validation; no production deployment).
- Cloudflare Workers Preview Build: success.
- Devnet read-only validation: success, including the Durable Objects runtime test step.
- Funded signed Devnet transfer: **skipped** because `DEVNET_RPC_URL` was not configured. No signed Devnet transaction lifecycle is claimed.

A further source review confirms the release blockers remain intentional and fail-closed:

- The public Worker routes and scheduled job operate the paper-trading state; the Worker exports but does not invoke `LiveTradeCoordinator`.
- The Jupiter transaction parser validates wire structure and indexes only. It returns `semanticInstructionVerification: false`; it does not resolve lookup-table addresses or semantically approve program IDs, account roles, or instruction data.
- The trusted sell-route probe requires the pinned bot wallet to already hold enough of the output token. This cannot establish an initial buy's exit path for a token the wallet does not yet own.
- Coordinator settlement transitions still reject because independent on-chain proof of confirmation, closure, or non-submission is not implemented.
- The coordinator has no trusted production caller or configured internal token in checked-in Wrangler configuration. No public coordinator route should be added.
- The funded signed Devnet lifecycle remains untested, and deployed Cloudflare production secrets, bindings, migrations, and cron settings have not been independently inspected.

**Release decision unchanged:** PR #27 remains Draft and unmerged. These successful checks validate the CI gates listed above; they do not authorize merge, production deployment, Mainnet signing, transaction submission, or live trading. Keep the application paper-trading only until the blocking items receive a separately reviewed implementation and explicit approval.


## Emergency-stop control-plane review — 2026-11-15 (source commit 8404bac17fe587a5557cd7618d9d203eb109cdab)

A focused re-review of `LiveTradeCoordinator`, its tests, the Worker route dispatcher, and Wrangler bindings confirms:

- The coordinator starts with `killSwitch: true`; reservations check it before external evidence retrieval and again inside the atomic reservation transaction. The regression test confirms activating the stop blocks subsequent reservations.
- The `/kill-switch` endpoint is protected by the coordinator's internal Bearer token and rejects malformed or missing credentials. There is no browser-facing Worker route or call site for the coordinator; the Worker only exports the Durable Object class. This keeps the current feature isolated.
- **Control-plane gap for any future integration:** the same internal Bearer credential authorizes both `enabled: true` and `enabled: false`. There is no separate operator/MFA authorization for re-arming, no role distinction, and no append-only audit trail for stop/re-arm events. This is not a currently reachable public exploit because the Worker does not expose or invoke the coordinator. Before a future live-trading integration, keep emergency activation available to trusted automation, but require a distinct, strongly authenticated operator approval to disable the stop; record actor, timestamp, reason, and previous/new state in durable audit evidence. Do not add a public route or weaken the current fail-closed default.
- Settlement remains deliberately blocked: the transition method rejects every confirm/fail/close request until independent chain proof or cryptographic proof of non-submission exists. Existing regression tests confirm caller-supplied booleans and explanations cannot release a pending reservation.
- The tests cover stop activation and credential rejection, but do not constitute an operator control-plane or settlement implementation.

**Decision unchanged:** this review found no safe reason to enable the live path. PR #27 remains Draft and unmerged; paper-trading only. No production deployment, signing, submission, or Mainnet activity was performed.


## Emergency-stop retry precedence fix — 2026-11-15

A focused review found that the coordinator's idempotent fast path returned an existing reservation before checking the emergency-stop state. Although this path did not itself sign or submit a transaction, a future trusted caller could incorrectly interpret the successful duplicate response as permission to continue processing while the stop was active.

The coordinator now checks the kill switch inside the same serialized state transaction before returning any duplicate reservation. An active stop therefore blocks both new reservations and retries of existing reservations. The reservation-history regression test now asserts that a duplicate retry receives HTTP 409 while the stop is active, then separately verifies the capacity guard after the stop is explicitly disabled.

This hardening does not implement signing, transaction submission, semantic Jupiter instruction verification, settlement, or a trusted production caller. The coordinator remains isolated and fail-closed. PR #27 remains Draft; no merge, production deployment, or Mainnet activity is authorized.


A follow-up race review found a second idempotency path inside the final reservation transaction: an in-flight request could finish evidence retrieval after another request had created the same reservation and the operator had activated the emergency stop. The final transaction now checks the stop before returning an existing reservation, matching the fast path. A regression test holds one evidence fetch, lets a concurrent same-key request reserve, activates the stop, then releases the in-flight request and verifies it is rejected with HTTP 409. This closes the duplicate-return race without weakening fail-closed behavior.

## Evidence freshness hardening — 2026-11-15 (commit c6eb4d8ffba37cbd2b0a0d0e5065c1be5420ef6b)

A source review found that trusted token-risk evidence previously received its `fetchedAt` timestamp only after all upstream requests, including paginated holder enumeration and the Jupiter sell-route probe. A slow evidence collection could therefore make earlier market, RugCheck, RPC, or holder responses appear newer than they were. The timestamp is now captured at the start of `fetchTrustedTokenRisk()`, before upstream requests begin. The coordinator's existing 30-second freshness check consequently measures age conservatively from the beginning of evidence collection and rejects a slow/stale collection instead of refreshing its apparent age at completion.

CI for `c6eb4d8ffba37cbd2b0a0d0e5065c1be5420ef6b`: Node tests **success**, frontend validation **success**, Cloudflare Worker dry-run build **success**, Devnet workflow **success**. The Devnet read-only checks passed; the funded signed transfer step was **skipped** because `DEVNET_RPC_URL` is not configured. This is not a signed transaction lifecycle test.

This is a freshness hardening change only. It does not implement semantic Jupiter instruction/lookup-table verification, settlement proof, a trusted production caller, or signing/submission. PR #27 remains Draft and unmerged. No production deployment, Mainnet signing, transaction submission, or live trading is approved.


## 2026-11-15 branch-head verification

Code head reviewed before this documentation-only addendum: `8cfded179336148f31925b0ddcceca7789409d02` (base `main`; PR was open and Draft). The addendum itself is a documentation-only change; it does not alter application code. This head adds a coordinator regression test that advances the clock by 31 seconds while trusted evidence is collected and verifies reservation rejection with HTTP 409 for stale risk evidence.

GitHub Actions for this exact head completed successfully:
- Validate frontend — run `43664419266`: success.
- Node tests — run `43664419210`: success.
- Cloudflare Worker build validation — run `43664419208`: success.
- Devnet signed lifecycle validation — run `43664419235`: overall job success, but the step “Verify ephemeral signing and submit a faucet-funded Devnet test transfer” was **skipped** because `DEVNET_RPC_URL` is not configured. The read-only Devnet checks and Durable Objects runtime tests passed; no signed Devnet transfer is claimed.

This is CI validation, not release approval. The code still reports `semanticInstructionVerification: false`; the coordinator requires semantic verification and therefore fails closed. Independent settlement proof remains unimplemented and coordinator state transitions remain disabled. The public Worker does not expose or invoke the live coordinator, and `executeLiveOrder()` still refuses to sign or submit transactions. Full Jupiter instruction and address-lookup-table verification, settlement/recovery proof, emergency-stop operator separation/integration, and a funded signed Devnet lifecycle remain release blockers.

**Decision unchanged:** keep PR #27 Draft and unmerged. No production deployment, Mainnet signing, transaction submission, or live trading is authorized by this review.

- Documentation addendum commit: `025834ee3f83a561354f422ea8a5978045941c81`. No application code changed in that commit. The workflow lookup for this documentation-only commit returned no PR-triggered runs; the four run results above apply to the reviewed code head `8cfded...`.


## Authentication rate-limit capacity fail-open fix — 2026-11-15

A source review found that AuthGuard.isRateLimited() checked only whether the requested scope had its own failure record. When all 1,000 bounded failure buckets were occupied, recordFailure() correctly reported a new scope as limited, but the pre-authentication isRateLimited() check returned false for that unrecorded scope. This meant rotating source scopes could bypass the intended pre-check while the table was full.

The guard now prunes expired buckets and fails closed for an unknown scope whenever the bounded table is full. Existing recorded scopes continue to use their own counters; after buckets expire, new scopes are evaluated normally. The capacity regression test now checks both the unknown-scope denial and recovery after expiry.

Validation for the code head before this documentation addendum, commit 3e41b68d2b87793ecf894e76168010c49c595e7e:
- Node tests: **111 passed, 0 failed**.
- Frontend syntax validation: **success**.
- Cloudflare Worker dry-run build: **success**.
- Devnet workflow: **success**; read-only checks passed, but the funded signed transfer step was **skipped** because DEVNET_RPC_URL is not configured.

The Devnet result does not establish a signed transaction lifecycle. This fix does not resolve semantic Jupiter instruction/ALT verification, settlement proof, emergency-stop operator separation, or the absence of a trusted production caller. PR #27 remains Draft and unmerged. No production deployment, Mainnet signing, transaction submission, or live trading is approved.


## AuthGuard hardening and branch-head verification — 2026-11-15

Reviewed the current AuthGuard and Worker authentication routes after the MFA challenge-state hardening.

- AuthGuard MFA challenge records now fail closed when persisted attempt counters are missing, non-integer, negative, or outside the supported range. Challenge creation also prunes malformed counters rather than retaining them.
- Added a regression test proving a malformed persisted attempt counter invalidates the challenge and cannot complete MFA.
- Re-reviewed Worker route ordering: same-origin protection runs before login and private API routes; private API session authorization precedes private handlers; TOTP setup and confirmation remain behind session authorization. No authentication bypass was identified in this source review.
- Current branch head: `f3463de50b89467a116a85f70e3b92f1b80b8095`.
- GitHub checks for this exact commit completed successfully: Node tests, JavaScript syntax, Cloudflare Worker validation, Devnet read-only checks, and Cloudflare Workers Preview build. These are CI/Preview results, not a production deployment.
- The funded signed Devnet transfer step remains skipped because `DEVNET_RPC_URL` is not configured. No signed transaction lifecycle is claimed.

The authentication hardening does not resolve the independent live-trading blockers: Jupiter instruction/account semantics and Address Lookup Table resolution remain unverified; settlement/recovery transitions remain disabled; the emergency stop is not integrated into the production Worker; and the coordinator remains isolated from the Worker. Production Cloudflare secrets, bindings, migrations, and cron settings have not been independently inspected.

**Decision unchanged: NOT APPROVED for Mainnet, signing, transaction submission, or live trading. PR #27 remains Draft and unmerged. No production deployment or Mainnet action is authorized.**


## Jupiter signer-set restriction — 2026-11-15

The unsigned Jupiter transaction structural parser now requires exactly one required signer, matching the dedicated expected bot wallet. Transactions that declare additional required signers are rejected rather than being treated as within the reviewed authorization model. A regression test covers the extra-signer case.

Validation for code commit `c3230a694f5aca5625270a6045263249c5ef5fea`:
- Node tests: **success**.
- JavaScript syntax: **success**.
- Cloudflare Worker build validation (dry-run; no deploy): **success**.
- Devnet read-only checks and Durable Objects runtime tests: **success**.
- Funded signed Devnet transfer step: **skipped** because `DEVNET_RPC_URL` is not configured.

This narrows the accepted transaction structure; it does **not** semantically decode or approve Jupiter instructions, resolve and verify Address Lookup Tables, or establish settlement/recovery proof. The coordinator continues to require semantic verification and remains fail-closed. The live coordinator remains isolated from the public Worker, and the emergency stop is not integrated into a production live-trading path.

**Decision unchanged: NOT APPROVED for Mainnet, signing, transaction submission, or live trading. PR #27 remains Draft and unmerged. No production deployment or Mainnet action is authorized.**
