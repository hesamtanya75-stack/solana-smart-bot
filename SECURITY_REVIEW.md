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

`fetchTrustedSellRoute()` now uses a Jupiter Swap API V2 quote-only request (no `taker`) to check whether a route is quoted without requiring the bot wallet to own the token before its first purchase. This is only a route quote: it returns no transaction and does not prove executable sellability. `validateUnsignedJupiterTransaction()` validates transaction wire structure only and explicitly returns `semanticInstructionVerification: false`; address lookup tables are not resolved or semantically verified. The risk evidence therefore cannot satisfy the coordinator's requirement for semantic instruction verification. **Reservations remain blocked by design.** Do not weaken these checks. A future implementation needs independently verified instruction/account/program decoding and address-lookup-table resolution, plus a safe exit-route verification design.

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


## Solana transaction format v1 compatibility gate — 2026-11-15

A compatibility review against the current Solana transaction documentation found that transaction format v1 is active on Mainnet, Devnet, and Testnet. The current parser in `trusted-live-evidence.mjs` intentionally accepts legacy and v0 message layouts only; its version-prefix check rejects v1 (and any unsupported future version) with an explicit error. The existing regression test for an unsupported versioned message exercises this fail-closed behavior.

This is safe rejection, not semantic verification or full current-format support. Solana v1 has a different message layout and does not use Address Lookup Tables; the current v0 ALT parser must not be reused as if it verified v1. Any future support must separately decode v1 configuration/resource fields, validate the complete instruction/account authorization model, and add official-format fixtures and regression tests before enabling any coordinator path. Until then, a Jupiter order encoded as v1 must remain unsupported and blocked.

Reference: current Solana documentation states v1 is active on Mainnet, Devnet, and Testnet, with a 4,096-byte limit and no Address Lookup Tables. This review does not change application code or authorize signing, submission, Mainnet activity, deployment, or merge.

**Decision unchanged:** PR #27 remains Draft and unmerged. Keep the live path disabled and fail-closed.


## Solana SDK candidate assessment — 2026-11-15

The current application dependency manifest contains no Solana SDK or transaction-introspection package; its only declared runtime dependency is `better-sqlite3`. The custom `validateUnsignedJupiterTransaction()` parser accepts legacy and v0 wire layouts and rejects v1 before interpreting its message. This is a fail-closed compatibility limitation, not evidence that v1 is semantically verified.

The official Solana documentation now describes `@solana/kit` and `@solana/transaction-introspection` as supporting legacy, v0, and v1 decoding. The introspection package resolves ALT-loaded addresses and outer/inner instructions from a `getTransaction` RPC response. However, that API shape is for confirmed transaction responses (including metadata/loaded addresses); it is not, by itself, a drop-in verifier for an unsigned Jupiter order before signing. It must not be wired into the pre-sign gate on the assumption that it independently proves the unsigned transaction's ALT contents or economic intent.

A safe implementation study must separately establish how to retrieve and validate each referenced ALT account at an appropriate commitment, resolve writable/readonly indexes with bounds and ownership/deactivation checks, decode the exact Jupiter and downstream program instructions, and prove that all accounts, amounts, destinations, fees, and token program operations match immutable order intent. The selected SDK version must be pinned with a reproducible lockfile and exercised in the Cloudflare Worker Preview build/runtime. No dependency or application code was changed in this assessment.

Cloudflare's current documentation says the project's `compatibility_date` of 2026-11-06 is after the 2026-08-04 Node.js compatibility default date. That is a favorable compatibility baseline, but does not prove this SDK bundle works in the Worker; Preview/runtime verification remains required.

References: Solana Versioned Transactions and Transaction Introspection documentation; Cloudflare Workers Node.js compatibility documentation. 

**Decision unchanged:** no semantic verification or settlement proof is implemented; coordinator stays fail-closed and isolated. PR #27 remains Draft and unmerged. No production deployment, signing, transaction submission, or live trading is approved.

## v0 instruction account-index bounds with ALT-loaded addresses — 2026-11-15

A parser review found that the v0 wire parser previously checked every compiled-instruction account index against the static account-key count only. Valid v0 instructions may also reference addresses loaded from lookup tables. The parser now counts writable and readonly loaded-address indexes across the lookup descriptors and validates instruction account indexes against the complete key-space size (static keys plus loaded addresses). Program-ID indexes remain restricted to static keys, consistent with the Solana v0 message rules. A regression fixture exercises an instruction account index that points to an ALT-loaded key.

This remains structural validation only: the parser does not fetch or authenticate the on-chain ALT accounts, resolve the actual public keys, validate lookup-table ownership/activation/deactivation, or decode Jupiter and downstream instruction semantics. Therefore it does not satisfy the coordinator's semantic-verification gate and must not enable reservation or signing.

Validation at code head `17d543f6690c96b6dfd895da9d11d521e2bf1eff`:
- Node tests: **success**.
- JavaScript syntax: **success**.
- Cloudflare Worker build validation (dry-run): **success**.
- Devnet read-only validation: **success**; funded signed Devnet lifecycle remains unverified unless the separate signed-transfer step runs with `DEVNET_RPC_URL`.

References: Solana's current v0 format documentation describes the full account-key vector as static keys followed by loaded writable and then loaded readonly addresses; the Solana protocol specification states instruction account indexes must be within that combined vector and program-ID indexes must refer to static keys.

**Decision unchanged:** PR #27 remains Draft and unmerged. No production deployment, Mainnet signing, transaction submission, or live trading is approved.


## Settlement evidence and ALT integration update — 2026-11-15

Reviewed the current application code at commit `3e7b504438515ed1d5417feb5a83227c311623c6` (PR #27 head at the time of this update is `b6cd2302d2a0f988b663eb31d99cc2edfc845699`; this commit contains documentation changes only).

### Implemented and tested

- The unsigned Jupiter transaction path now calls `validateAndResolveUnsignedJupiterTransaction()`. For transaction-bearing legacy/v0 orders it performs wire-structure validation and resolves supplied ALT descriptors against finalized on-chain account data, checking ALT ownership, deactivation/warm-up state, index bounds, and compiled-key ordering.
- The Jupiter quote-only request deliberately omits `taker`. That response has `transaction: null`; consequently it cannot exercise transaction parsing or ALT resolution and is not proof of executable sellability.
- If an order response does contain an unsigned transaction, the evidence status is explicitly `unsigned-structure-and-alt-only`. It continues to report `semanticInstructionVerification: false`; no router or downstream program instruction is treated as approved.
- `verifyFinalizedJupiterSettlement()` now checks signature status at finalized commitment, transaction success, signature inclusion, bot-wallet fee-payer position, and exact owner-scoped input/output token balance deltas for the requested mints and amounts. Wrapped SOL input is checked through its SPL token balance delta rather than a lamport delta that could be confounded by fees or rent.
- The coordinator's `confirmed` transition requires that independent proof to match the pending reservation and pinned bot wallet. Duplicate confirmation with the same signature is idempotent; a different signature is rejected. Failure and close transitions remain blocked because independent proofs for those states are not implemented.
- Regression tests cover valid settlement evidence, mismatched output, non-finalized status, a different fee payer, coordinator proof matching, and replay protection.

### Remaining blockers and validation boundary

- Semantic instruction verification is **not implemented**. Program IDs, instruction discriminators/types, account roles, token mints, amounts, destination, and downstream operations are not yet decoded and matched against immutable intent. The coordinator therefore remains fail-closed for new reservations.
- Quote-only Jupiter evidence contains no transaction. The transaction-bearing order path has structural/ALT resolution only; neither path establishes semantic route safety.
- Funded signed Devnet lifecycle validation was skipped because `DEVNET_RPC_URL` was absent. The successful Devnet workflow performed read-only checks only; logs state signing was not performed and zero transactions were submitted.
- CI for code commit `3e7b504438515ed1d5417feb5a83227c311623c6`: Node tests **139 passed, 0 failed**; frontend validation **success**; Cloudflare Worker dry-run build **success**; Devnet read-only workflow **success**, with funded transfer skipped. These results do not prove production runtime configuration or a signed transaction lifecycle.

**Decision unchanged:** PR #27 remains Draft and unmerged. No production deployment, Mainnet signing, transaction submission, or live trading is approved. Keep all semantic-verification gates and the disabled execution path fail-closed.

## Jupiter V2 router coverage and semantic-verification boundary — 2026-11-15

The current Jupiter V2 documentation was checked against the transaction parser and order integration. It confirms an important constraint on any safe semantic decoder:

- `/swap/v2/order` without `taker` is quote-only and returns no assembled transaction. Supplying `taker` is required to receive a transaction. The current sell-route probe intentionally omits `taker`, so it remains a price/route quote only and cannot prove that a wallet-specific executable exit transaction is safe.
- The Meta-Aggregator `/order` path can select among **Metis, JupiterZ RFQ, Dflow, and OKX**. The response identifies the selected router. Its transaction version is not uniform: v1 is currently limited to eligible non-gasless Metis orders when requested as a supported ceiling; other routers and gasless orders return v0.
- The alternative `/build` path returns raw instructions and ALT data but is **Metis-only**; it is not interchangeable with the multi-router `/order` path. Jupiter documents `/execute` for signed `/order` transactions, not `/build` transactions.
- Consequently, a decoder that assumes one Jupiter program/discriminator/account layout, or that trusts `routePlan`/router labels without decoding the returned compiled instructions and resolved account keys, would not cover the advertised order surface. The current parser's structural validation and finalized ALT resolution are useful prerequisites, but do not prove instruction intent.

### Current safe state

- Legacy/v0 structural parsing and finalized ALT resolution are integrated for transaction-bearing order responses. V1 parsing is structural and has no ALT vector.
- Resolved ALT keys remain untrusted as instruction semantics until each compiled instruction is decoded against a pinned, versioned allowlist for the actual selected router and every permitted downstream program.
- The verifier must bind the decoded instruction sequence to immutable order intent: exact input/output mints and raw amounts, pinned taker/receiver, token-account owners, allowed token programs, fees/tips, and permitted account roles. Unknown routers, programs, discriminators, account layouts, or extra value-moving instructions must reject.
- No trustworthy, complete, version-pinned decoder/allowlist for all four Meta-Aggregator router families is present in this repository. Therefore `semanticInstructionVerification` must remain `false`, route status must not be promoted to semantically verified, and the coordinator must continue rejecting new reservations. No heuristic or router-label-only shortcut is acceptable.

Official references checked:
- Jupiter Order & Execute: https://developers.jup.ag/docs/swap/order-and-execute
- Jupiter Swap API overview (Meta-Aggregator versus Metis-only Router path): https://developers.jup.ag/docs/swap
- Jupiter /order API reference: https://developers.jup.ag/docs/api-reference/swap/order
- Jupiter /build API reference: https://developers.jup.ag/docs/api-reference/swap/build

**Decision unchanged:** this is a documentation-only security clarification. No transaction signing, submission, live-trading path, merge, or production deployment is authorized. PR #27 remains Draft and unmerged.

## CI verification for Jupiter router review — 2026-11-15 (commit `7006781f60ff1e4fef9cd4e8c5bdab4afe1c3542`)

GitHub Actions completed successfully for this exact documentation commit:

- Frontend JavaScript syntax validation: success.
- Node tests: **139 passed, 0 failed, 0 skipped**.
- Cloudflare Worker build validation: success (dry-run only; no deployment).
- Devnet read-only validation: success; the workflow identified Devnet and completed read-only RPC checks.
- Funded signed Devnet lifecycle: **skipped** because `DEVNET_RPC_URL` was empty. The job log explicitly reports `signing: not performed` and `transactionsSubmitted: 0`.

These results verify repository tests and build checks only. They do not complete the funded Devnet lifecycle, semantic Jupiter instruction verification, or independent verification of production Cloudflare configuration. The Jupiter semantic gate remains false; the coordinator remains fail-closed. PR #27 remains Draft and unmerged. No production deployment, Mainnet signing, transaction submission, or live trading is authorized.

## Narrowing Jupiter V2 order routing to Metis — 2026-11-15

The transaction-bearing `/order` request now explicitly sets `receiver` to the pinned taker wallet and `excludeRouters=jupiterz`, then rejects any response whose `router` is not exactly `metis`. This is based on Jupiter's documented routing-impact matrix: `receiver` disables Dflow and OKX, and `excludeRouters=jupiterz` disables JupiterZ, leaving Metis as the only eligible router. The same wallet is used for taker and receiver; no alternate destination is accepted.

A focused unit test asserts both query parameters and rejects a syntactically valid transaction response labeled `dflow`. This narrows the semantic-decoder scope, but does **not** establish semantic safety: Metis instructions, all downstream AMM CPI programs, account roles, token mints, amounts, fees, and destination effects still require decoding and verification. `semanticInstructionVerification` therefore remains `false`, and no route is marked semantically verified. Unknown or unexpected router responses fail closed.

Official Jupiter routing matrix: https://developers.jup.ag/docs/swap/order-and-execute#routing-impact-matrix

The code commits are `23a85a9bb1585683fa1931f1587f3872d49814b0`, `723771ce503da8076dbb1c311ef2e265955c7b59`, and `49f53e6ebffb6404e2e74fe77f5c76842a9b0aa6`. CI for the latest code commit has not yet reported. No signing, transaction submission, merge, or production deployment was performed; PR #27 remains Draft and unmerged.

## Jupiter v0 order-to-ALT integration regression coverage — 2026-11-15

The live-order preparation path now has end-to-end unit coverage for a Jupiter Metis v0 order that references an Address Lookup Table. The test verifies that the unsigned order is passed through structural parsing, that the referenced ALT account is fetched with getMultipleAccounts at finalized commitment, and that the resolver returns the expected writable and readonly public keys. A companion negative test proves the order is rejected when the ALT account is owned by the wrong program. The existing fail-closed status remains unchanged: semanticInstructionVerification is false; resolving ALT addresses is not instruction authorization or economic-intent verification.

Validation at code head f4a6357019066db034a1c46a203d7893b20d97a8:
- Node tests: 142 passed, 0 failed, 0 skipped.
- Frontend JavaScript syntax validation: success.
- Cloudflare Worker build validation: success, build-only with no deployment.
- Devnet read-only validation: success.
- Funded signed Devnet lifecycle: skipped because DEVNET_RPC_URL is not configured; logs explicitly report signing not performed and zero transactions submitted.

PR #27 remains Draft, Open, and Unmerged. No production deployment, Mainnet signing, transaction submission, or live trading was performed or authorized.


## Correction: Jupiter receiver must differ from taker — 2026-11-15

A follow-up check against the current official `/order` API reference found that `receiver` is explicitly required to differ from `taker`. The earlier request populated both with the same pinned bot wallet; that was invalid and could cause Jupiter to reject the order request.

The request now omits `receiver` to preserve the single-wallet model and pinned settlement destination. It retains `excludeRouters=jupiterz`, but this parameter alone does **not** guarantee Metis-only routing: Dflow and OKX may still be eligible. The code therefore accepts only a response whose actual `router` field is exactly `metis` and rejects all other router responses. This is a fail-closed selection check, not semantic instruction verification and not a claim that only Metis was eligible upstream.

Regression tests now assert that `taker` is the pinned bot wallet, `receiver` is absent, JupiterZ is excluded, and non-Metis responses are rejected. Node tests: 142 passed, 0 failed, 0 skipped; frontend validation, Cloudflare Worker build-only validation, and Devnet read-only validation completed successfully on code commit `43bceacd631472929659c60e0703ca219e0cbffc`. Funded signed Devnet lifecycle remained skipped because `DEVNET_RPC_URL` is empty; no signing or transaction submission occurred.

Semantic instruction verification remains false. The coordinator remains fail-closed. PR #27 remains Draft and unmerged. No production deployment, merge, Mainnet signing, transaction submission, or live trading was performed.


## Semantic-verification source audit — 2026-11-15

A source audit was performed before attempting to add a Jupiter instruction decoder.

- Jupiter's current developer documentation states that the legacy Metis Swap API V1 is superseded by Swap API V2 and links the Jupiter Swap Program IDL through its own documentation to the on-chain Jupiter v6 program account: `https://developers.jup.ag/docs/swap/v1/common-errors`.
- The checked-in `jup-ag/instruction-parser/src/idl/jupiter.ts` snapshot contains the older route instruction family and does not define the newer `routeV2`, `sharedAccountsRouteV2`, `exactOutRouteV2`, or `sharedAccountsExactOutRouteV2` instructions. It is therefore not sufficient as the sole schema for a current V2 order verifier.
- A third-party IDL mirror contains the v2 discriminators and a large `Swap` enum, but a mirror is not accepted as the sole authority for a security-critical allowlist. The exact on-chain IDL/version must be pinned and independently reconciled before code is written.
- Jupiter's own documentation also notes that DEX programs invoked by a route may return errors and that some DEXes do not publish an IDL or open-source code. A complete verifier must therefore validate each supported route variant and its actual downstream program/account semantics, not merely the Jupiter top-level discriminator or the API `routePlan`.

No semantic decoder was added from incomplete or mirrored data. `semanticInstructionVerification` remains false and the coordinator remains fail-closed. This source audit changes documentation only; it does not authorize signing, submission, deployment, or live trading.

References:
- Jupiter Swap V2 overview: `https://developers.jup.ag/docs/swap/index`
- Jupiter Swap Program IDL pointer and DEX-IDL limitations: `https://developers.jup.ag/docs/swap/v1/common-errors`
- Jupiter instruction parser IDL snapshot: `https://github.com/jup-ag/instruction-parser/blob/main/src/idl/jupiter.ts`
- Third-party current IDL mirror used only for comparison: `https://github.com/solana-foundation/surfpool/blob/main/crates/core/src/scenarios/protocols/jupiter/v6/idl.json`

## Jupiter Router / transaction-version follow-up — 2026-11-15

The current official Jupiter Build and Transaction Versions documentation was checked against the repository's transaction parser and the existing V2 /order integration.

- /swap/v2/build is the Metis Router path and returns raw instruction objects (programId, account metas, and base64 instruction data), routePlan, otherAmountThreshold, and address-lookup-table address lists for v0. It does not return the serialized transaction used by the current /order parser, and /build transactions cannot use /execute.
- /build supports the case-sensitive dexes filter. This can narrow routing to explicitly selected DEX labels, but the label and API routePlan are not proof of on-chain program identity or safe account semantics. A verifier must decode the actual returned instructions and validate all relevant account addresses, pool state, mints, amounts, fees, and downstream program behavior.
- For v0 /build, the API supplies lookup-table address lists; these must not be trusted as finalized on-chain ALT state. The existing resolver's owner, activation, deactivation, warm-up, and index checks remain relevant only after the exact lookup-table accounts and compiled indexes are independently tied together.
- Jupiter's October 2026 documentation defines Solana transaction v1 as a distinct 4,096-byte format with up to 64 inline accounts and no ALTs. /build forces it with transactionVersion=1; /order only requests it as a ceiling with maxSupportedTransactionVersion=1, and may still return v0. The current code does not request that ceiling, so the existing /order path remains on the default v0 unless its request is deliberately changed. The parser's v1 structural branch is not semantic verification.
- A future /build-based verifier would need a separate raw-instruction evidence path; passing a /build response into validateAndResolveUnsignedJupiterTransaction is not valid because that helper accepts a serialized unsigned transaction, not the raw instruction response.

No application code was changed in this follow-up. No API endpoint was switched, no DEX allowlist was enabled, and no new transaction path was created. semanticInstructionVerification remains false; reservations/signing/submission remain blocked. PR #27 remains Draft and unmerged.

References:
- Jupiter Build: https://developers.jup.ag/docs/swap/build
- Jupiter Transaction Versions: https://developers.jup.ag/docs/swap/advanced/transaction-versions
- Jupiter October 2026 changelog: https://developers.jup.ag/changelog/2026-10

## Review update — 2026-11-15 (latest Devnet attempt)

- The Devnet workflow now attempts the signed lifecycle test on every PR run. It uses `DEVNET_RPC_URL` when configured and otherwise falls back to the official public Devnet RPC; it no longer silently skips the funded test just because the secret is absent.
- On commit `31ed776088639140bf40b3aff91e11477747f721`, Node/runtime tests passed **152/152**, the Devnet cluster identity and read-only RPC checks passed, and the Cloudflare Worker dry-run build passed.
- The funded lifecycle was actually attempted, but the public Devnet RPC faucet returned HTTP **410 Gone**. The workflow correctly failed the funded step and reported that offline signature verification is not an on-chain lifecycle pass. No funded transfer was submitted.
- To complete this test, configure a dedicated Devnet RPC endpoint with working faucet/airdrop support as the GitHub Actions repository secret `DEVNET_RPC_URL`. Never put the endpoint or API key in source code or chat.
- Semantic instruction verification is still **not implemented**. The transaction parser and ALT resolver prove wire structure and lookup-table resolution only. Jupiter's current V2 `/order` path is a multi-router endpoint; accepting a response labelled `metis` is not a substitute for decoding the Jupiter instruction, every downstream AMM CPI, and all account/mint/amount roles against pinned, versioned schemas. The coordinator therefore continues to reject reservations unless `semanticInstructionVerification === true` and `routeVerification === "semantically-verified"`.
- No Mainnet signing, submission, live trading, merge, or production deployment was performed. Keep PR #27 Draft and unmerged.


## CI follow-up — 2026-11-15 (Devnet workflow correction; verified head 54b6f187ce9c03611697ddf93fe5ac23811903bb)

The preceding attempt on commit `928494c59fa545b1ae26678ba41bb92259ee8bc7` ran the funded lifecycle against the public Devnet RPC because `DEVNET_RPC_URL` was empty. The faucet returned HTTP 410, so the funded lifecycle failed; this was an unavailable external faucet, not a failed unit test or a Mainnet interaction.

The workflow was corrected on branch `security/pr26-clean-main`:
- The funded signing/transfer step now runs only when the dedicated `DEVNET_RPC_URL` secret is present.
- When the secret is absent, GitHub Actions marks the funded step **skipped** and emits an explicit summary with `signing: not performed` and `transactionsSubmitted: 0`.
- A regression test in `tests/devnet-lifecycle-gate.test.mjs` verifies the conditional gate and the explicit skipped result.
- A follow-up shell-quoting issue in the summary text was corrected and covered by an assertion; the final job log contains no shell command-substitution error.

Verified GitHub Actions for head `54b6f187ce9c03611697ddf93fe5ac23811903bb`:
- Node tests: **153 passed, 0 failed, 0 skipped**.
- Frontend JavaScript syntax validation: success.
- Cloudflare Worker build: success (dry-run only; no deployment).
- Devnet read-only cluster/RPC validation: success.
- Funded signed Devnet lifecycle: **skipped**, because `DEVNET_RPC_URL` is not configured. No signing or transaction submission occurred.
- The read-only Devnet output still warns that public RPC rate-limited holder enumeration; holder concentration was not validated.

The combined commit status still includes the legacy `deploy/hesamtanya75-stack/solana-smart-bot-17` Deno Deploy failure. This is separate from the four current GitHub Actions workflows above and is not evidence of a Cloudflare Worker build failure.

The release decision is unchanged: semantic Jupiter instruction verification remains false, settlement transitions remain disabled, and the Worker still does not provide an enabled end-to-end live-trading path. Production Cloudflare secrets/bindings/migrations have not been independently verified. Keep PR #27 Draft and unmerged; paper-trading only. No production deployment, Mainnet signing, transaction submission, or live trading was performed.

## CI and Jupiter routing review — 2026-11-15 (verified PR head `1f8b20d62fa564870e95e43c7dab71d955719a6e`)

Fresh GitHub Actions results for this PR head:
- Frontend validation: passed.
- Cloudflare Worker build validation: passed (build/dry-run only; no deployment).
- Node tests: passed.
- Devnet workflow job: passed, but the funded signed-transfer step was **skipped** because `DEVNET_RPC_URL` is not configured. Devnet read-only checks passed. A green job therefore does not establish a funded on-chain lifecycle pass.

The current official Jupiter Swap API V2 documentation clarifies an important routing limitation:
- `/order` is the Meta-Aggregator path. Metis, JupiterZ RFQ, Dflow, and OKX compete; setting `excludeRouters=jupiterz` does not make the endpoint Metis-only. The application rejects a returned router unless it is labelled `metis`, so non-Metis responses fail closed after selection, but the request is not an upstream Metis-only route restriction.
- `/build` is the Metis-only Router path, but it returns raw instruction objects and address-lookup-table address lists rather than the serialized unsigned transaction consumed by the current `validateAndResolveUnsignedJupiterTransaction` helper. A `/build` integration therefore requires a separate raw-instruction evidence parser and independent validation of the compiled account indexes, every program ID, all relevant account roles, token mints, amounts, fees, and downstream AMM/CPI semantics. The current serialized-transaction parser cannot be reused as if it verified a `/build` response.
- The official `program-id-to-label` endpoint is descriptive metadata, not a security allowlist or proof of program identity/version. A production verifier still needs pinned, authoritative schemas and verified program deployments for Jupiter and each supported downstream AMM, plus adversarial tests.

Official references reviewed:
- https://developers.jup.ag/docs/swap/index
- https://developers.jup.ag/docs/swap/build
- https://developers.jup.ag/docs/api-reference/swap/order
- https://developers.jup.ag/docs/api-reference/swap/program-id-to-label

No application execution path was enabled by this review. `semanticInstructionVerification` remains false for live evidence; the coordinator rejects reservations without an independently verified semantic attestation; `executeLiveOrder()` still throws; the Worker has no enabled end-to-end live-trading path. Do not treat this documentation update or green CI as Mainnet approval. Keep PR #27 Draft and unmerged. No deployment, signing, transaction submission, or live trading was performed.

## Devnet RPC resilience update — 2026-11-15 (code commit `efa75d773a64687582de63043fcb8e29819474f1`; regression test commit `c4f99ad6e5caa63ce9187b9d31d8ae4e979075bc`)

- The read-only Devnet preflight now retries transient fetch/network failures and timeouts, in addition to retryable HTTP statuses, with bounded attempts and backoff.
- It validates the JSON-RPC 2.0 envelope, response ID, JSON shape, and presence of the result before consuming RPC data.
- Error messages avoid printing the configured RPC URL, which may contain a provider API key.
- Added a regression test asserting these retry, envelope-validation, and no-URL-logging guards.
- These changes improve preflight resilience only. They do not provide the missing dedicated faucet-capable Devnet endpoint, and they do not establish a funded signed transaction lifecycle.
- No Mainnet signing, transaction submission, live trading, production deployment, or merge was performed. PR #27 remains Draft and unmerged.


## Jupiter program provenance and upgradeability review — 2026-11-15

A follow-up source-provenance check found that Jupiter's own legacy Metis error documentation links the Jupiter Swap Program IDL to the on-chain program account on Solscan. The explorer currently identifies `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` as Jupiter Aggregator v6 and reports the program as upgradeable, with an upgrade authority. This is important: a program ID alone does not pin immutable executable behavior.

Current third-party generated decoder references expose V2 instruction families (including `routeV2` and `sharedAccountsRouteV2`) and typed route-plan fields. These are useful cross-checks for research, but they are not accepted as the sole authority for a security-critical verifier. The checked-in Jupiter instruction-parser snapshot remains an older schema and is not sufficient to authorize the current V2 order path.

Before any semantic verifier can be considered, a separate review must:
- obtain and pin the authoritative on-chain IDL and its exact hash/version;
- record and verify the deployed Jupiter program's ProgramData/deployment identity and define how upgrades invalidate or renew the allowlist;
- reconcile instruction discriminators, argument layouts, account order/flags, and optional/remaining-account behavior against independent official or on-chain evidence;
- decode and constrain every permitted downstream AMM CPI and every value-moving setup, cleanup, token, system, compute-budget, and tip instruction;
- bind the decoded sequence to the immutable order intent, including exact mints, raw amounts, token-account owners, destination, fee recipients and maximum fees.

The explorer's current upgradeability/authority metadata is evidence about the program's mutability, not evidence that any particular instruction is safe. No decoder, allowlist, or execution capability is enabled by this review. `semanticInstructionVerification` remains false; the coordinator remains fail-closed; PR #27 remains Draft and unmerged. No signing, submission, Mainnet activity, merge, or production deployment is authorized.

References:
- Jupiter documentation linking the Swap Program IDL: https://developers.jup.ag/docs/swap/v1/common-errors
- Jupiter Aggregator v6 program account and current upgradeability metadata: https://solscan.io/account/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
- Jupiter's current Swap API V2 routing and build/order distinction: https://developers.jup.ag/docs/swap


## Solana v1 resource-configuration validation — 2026-11-15

A review against Solana's current v1 transaction-format documentation found that v1 transactions must explicitly include both a non-zero compute-unit limit and a non-zero loaded-account-data-size limit. Omitted fields default to zero, which makes the transaction non-executable. The unsigned-message parser previously accepted v1 envelopes with these required fields absent.

The parser now rejects v1 messages unless config-mask bits 2 and 3 are both present, and validates the decoded values against the supported transaction resource bounds: compute units 1..1,400,000 and loaded account data 1..64 MiB. Existing optional priority-fee and heap-size parsing remains in bit order; heap requests retain the protocol's 32..256 KiB, 1 KiB-alignment validation. Regression coverage now includes missing limits, zero limits, valid configured v1 fixtures, and the instruction-header offset after config values.

This is stricter structural/executability validation only. It does not decode program instructions, establish account roles or economic intent, authenticate any Jupiter or downstream program behavior, or promote semantic trust. `semanticInstructionVerification` remains false; the coordinator remains fail-closed.

References:
- Solana Versioned Transactions: https://solana.com/docs/core/transactions/versioned-transactions
- Solana Compute Budget: https://solana.com/docs/core/fees/compute-budget
- SIMD-0385 transaction v1 proposal: https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md

CI must pass on the final branch head before this change is considered validated. PR #27 remains Draft and unmerged. No production deployment, signing, transaction submission, or Mainnet activity is authorized.


## Solana v1 optional priority-fee config regression coverage — 2026-11-15

The official v1 wire-format documentation specifies that config bits 0 and 1 must be set together for the optional u64 total-priority-fee field, and that config values follow ascending bit order. Added regression fixtures that include the optional priority fee, verify that a single priority-fee mask bit is rejected, and verify the combined priority-fee + compute-limit + loaded-data-limit + heap-size layout. This protects the parser's offset calculation from silently shifting the instruction section.

The priority-fee field is only structurally consumed; no fee policy or economic approval is inferred. Semantic instruction verification remains false and live execution remains blocked.

Reference: https://solana.com/docs/core/transactions/versioned-transactions

## CI completion and V1 boundary-test update — 2026-11-15 (code commit 996ecaab59aab41fe64745b10b815ab34b2489fc)

GitHub Actions for the current branch head completed successfully:

- Frontend JavaScript validation: success.
- Node safety and Durable Objects runtime tests: **189 passed, 0 failed, 0 skipped**.
- Isolated Miniflare dependency audit: **0 vulnerabilities reported**.
- Cloudflare Worker validation: success; Wrangler dry-run only, no deployment.
- Devnet read-only cluster identity/RPC checks: success.
- Funded signed Devnet transfer: **skipped**, because `DEVNET_RPC_URL` is not configured. No signing or transaction submission occurred.

The test log specifically confirms the V1 compute-unit and loaded-data upper-bound test and the inclusive 256 KiB heap-size boundary test passed. The parser continues to reject values outside its configured supported ranges. These are structural resource checks only; they do not validate instruction semantics or economic intent.

The PR remains Draft, Open, and unmerged. `semanticInstructionVerification` remains false; live reservations/signing/submission remain blocked. No production deployment, Mainnet activity, or real transaction was performed.


## External provider response-size hardening — 2026-11-15 (verified code head `c4d80ba996a62dd99c47a2e4909706105085d402`)

A final Worker-path review found that the scanner's external Solana RPC and DexScreener calls still parsed provider bodies with unbounded `response.json()`, even though the trusted-live-evidence module already enforced a response-size ceiling. This gap is now closed:

- Added a shared bounded JSON response reader in `rpc-response.mjs` with a 2 MiB maximum.
- The reader rejects an oversized declared Content-Length before consuming the body, counts streamed bytes and cancels once the limit is exceeded, rejects invalid UTF-8 and malformed JSON, and releases the stream reader lock.
- Worker single RPC, batched RPC, generic provider JSON, and DexScreener response parsing now use the bounded reader. The remaining direct `response.json()` calls in `worker.js` are only for internal Durable Object responses, not external provider bodies.
- Added regression tests for valid bounded JSON, declared-size rejection before body reads, streamed-size rejection, malformed JSON, and invalid UTF-8. Updated the Worker VM integration harness to inject the shared reader.

Verified GitHub Actions on code head `c4d80ba996a62dd99c47a2e4909706105085d402`:
- Node safety and Durable Objects runtime tests: **196 passed, 0 failed**.
- Dependency audit: **0 vulnerabilities reported**.
- Frontend JavaScript validation: success.
- Cloudflare Worker build validation: success (dry-run only; no deployment).
- Devnet cluster identity and read-only RPC validation: success.
- Funded signed Devnet transfer: **skipped**, because `DEVNET_RPC_URL` is not configured. No signing or transaction submission occurred.

The change hardens provider response handling; it does not alter the paper-trading rules or enable live trading. `semanticInstructionVerification` remains false, the coordinator remains fail-closed, and the Worker still has no enabled end-to-end live-trading path. PR #27 remains Draft, Open, and unmerged. No production deployment, merge, Mainnet signing, transaction submission, or live trading was performed.


## Jupiter bounded-response regression and latest CI — 2026-11-15 (code head `fb1caeba228e8dcf2ddd12eb3ee48209dc5cb928`)

The Jupiter `/order` response now uses the shared 2 MiB bounded JSON reader. A regression test initially used a native `Response` whose stream implementation precluded asserting that an oversized declared Content-Length is rejected before body consumption. The test fixture was corrected to expose a minimal readable-body interface and headers, preserving the intended pre-read assertion without changing production behavior.

GitHub Actions on this exact head completed successfully:
- Node test suite: **198 passed, 0 failed, 0 skipped**.
- Dependency audit: no dependency vulnerabilities reported.
- Frontend JavaScript validation: passed.
- Cloudflare Worker build validation: passed (Wrangler dry-run only; no deployment).
- Devnet read-only cluster/RPC preflight: passed.
- Funded signed Devnet lifecycle: **skipped**, because `DEVNET_RPC_URL` is not configured. No signer was created, no signing occurred, and no transaction was submitted.

These results validate the current automated checks and response-size regression. They do not establish Jupiter instruction semantics, wallet signing safety, a funded Devnet transaction lifecycle, or Mainnet readiness. `semanticInstructionVerification` remains false; live coordinator and Worker execution remain fail-closed. PR #27 remains Draft, Open, and unmerged. No deployment, merge, Mainnet access, signing, or real-money transaction occurred.
