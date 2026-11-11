## Saber StableSwap disposition — blocked pending binary verification

The official Saber repository identifies the StableSwap program as `SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ` and publishes Rust source and client instruction/account definitions. Its swap ABI is a one-byte instruction tag followed by little-endian `amount_in` and `minimum_amount_out`; the source describes nine ordered accounts for a swap. However, the publicly surfaced Mainnet program record reports the deployed binary as **Unverified Binary**. The published source/IDL-like client definitions therefore cannot, by themselves, be treated as proof of the currently deployed Mainnet executable.

The Metis validator now hard-blocks a route when either its trusted DEX program mapping identifies the Saber StableSwap Program ID or the quote labels the venue as `Saber`. This is intentional fail-closed behavior. No generic test callback can override this block. Unit fixtures use a clearly synthetic `TestDEX` label and do not imply any real DEX approval.

Before Saber can be reconsidered, an independent review must:
1. Fetch the current Mainnet executable and deployment/upgrade metadata for the exact program address.
2. Reproducibly build the official Saber source at a pinned commit/toolchain and compare the resulting binary to the deployed executable (or obtain independently verifiable build provenance).
3. Pin the exact source commit, build inputs, deployed binary hash, and upgrade-authority status.
4. Implement a route-specific CPI validator that checks the nine-account order, signer and writable privileges, pool-state owner/layout/initialized/paused fields, PDA authority, reserve and fee-vault addresses, token mint/owner relationships, token program, and exact input/minimum-output semantics against trusted RPC account data.
5. Add fixtures from independently verified Mainnet transactions plus negative/fuzz tests, then pass CI and independent review.

Until all gates pass, Saber remains unsupported and no DEX is approved for live execution. This change does not enable signing, submission, or production routing.

## DEX-specific CPI semantics are now a mandatory fail-closed gate

The Metis route validator now requires a per-swap-variant semantic validator supplied by trusted policy. It receives the exact decoded Jupiter instruction, parsed on-chain route step, quote step, DEX program ID, and AMM key. Missing, throwing, or negative validators reject the order. The generic program/label/AMM membership checks alone are not treated as a DEX security audit.

**Important limitation:** this repository still does not contain independently reviewed, production-ready validators for Saber or other DEXes. The unit-test callback is a fixture only and must never be copied into production policy. Until each supported DEX has a reviewed validator that checks its exact CPI account order, pool/vault/PDA derivations, token mints, authorities, and amount flow against the deployed program/IDL, the route must remain rejected. No DEX is approved for live execution by this change.

# Program / Account / CPI / ALT security audit — PR #17

## Scope and disposition

Reviewed branch `live-trading-policy-enforcement`. This is a static code and test review only. No wallet was connected, no transaction was signed or submitted, and no production deployment or merge was performed.

**Disposition: Stage 2 is NOT complete. Keep every live-execution path disabled.** The current code has useful fail-closed scaffolding, but it does not establish that a real Jupiter swap route is safe.

## Findings

| Area | What exists | Remaining blocker |
|---|---|---|
| Transaction decoding | Legacy and v0 message decoding; canonical Base64 and size checks; bounded instruction/account counts; instruction account indexes are resolved. The decoder exposes per-key signer/writable flags and whether each key came from the static message or an ALT, including lookup table and address index. | Privileges are message-declared; they do not establish token-account ownership, mint, authority, or protocol-specific safety. |
| Program allow-list | Caller must provide a non-empty Program ID allow-list; every outer instruction Program ID must be present. | No reviewed production Program ID set is supplied or wired. Never derive it from Jupiter's response or `routePlan`. |
| Account allow-list | Caller must provide a non-empty Account key allow-list; all message keys and instruction account references must be allow-listed; dedicated signer is pinned. The policy also requires complete decoder privilege metadata and a separate non-empty writable-account allow-list. | No reviewed production account policy is supplied or wired. Key membership and message privileges do not establish token-account mint/owner, authority, fee destination, or token-program relationships. |
| Semantic validation | Every invoked outer program requires a trusted validator returning exactly `{ allowed: true }`; missing, throwing, or rejecting validators fail closed. | No production protocol-specific validators exist. A permissive test validator is only a harness fixture, not evidence that a swap instruction is safe. |
| Jupiter router selection and quote fields | `getJupiterOrder` now requests ExactIn and transaction version 0, excludes JupiterZ/Dflow/OKX, and requires the trusted policy to name only Metis. It rejects non-Metis responses, gasless orders, a signature fee payer other than the pinned taker, unexpected mode/version, fee mint outside the input/output pair, malformed fee basis points, inconsistent minimum output/slippage, missing block-height expiry, incomplete route steps, and any order without a trusted RPC block-height provider confirming the expiry is in the future and within a 150-block window. | This is response-level fail-closed validation, not a protocol semantic validator. The trusted block-height provider is an injected server-side dependency and is not wired into the Worker. Quote fields still need to be bound to decoded instruction semantics. No production Metis DEX/program/account allow-list or protocol validator exists; do not enable live execution. |
| CPI | A standalone `validateSimulatedCpi` helper validates a successful simulation's explicit `innerInstructions` trace, checks outer-instruction group indexes, resolves inner program/account indexes, and rejects CPI programs/accounts outside separate allow-lists. Unit tests cover missing/failed traces, unknown CPI programs/accounts, malformed groups, and out-of-range indexes. | The helper is not wired to a trusted RPC simulation call or the Jupiter order path. No production CPI allow-list exists. Simulation is diagnostic and may differ from execution; it does not replace protocol-specific instruction semantics or guarantee against state changes. Until exact route/version semantics and trusted simulation binding are implemented, reject live execution. |
| Address Lookup Tables | A standalone trusted resolver helper checks an explicitly pinned HTTPS RPC endpoint, canonical ALT Program ownership, active state, bounded table metadata, RPC context freshness, and extension-slot delay. Decoder/policy tests cover lookup resolution and index bounds. | The helper is not wired into the Worker or live-order path. Trusted endpoint/configuration still require independent operational review; constructed fixtures do not prove live RPC behavior. |
| Parsed token-account validation | A standalone validator now checks trusted parsed RPC account context, token-program ownership, exact mint and authority, initialized state, absence of delegate/close authority, native-account policy, amount/decimals, and explicit Token-2022 extension allow-list. Unit tests cover mismatches, frozen/delegated/closable accounts, stale slots, low balance, and unknown extensions. | The helper is not wired to trusted RPC account reads or the live-order path. The Worker does not supply a reviewed token-account policy; Token-2022 mint-level extensions and protocol-specific account relationships still require separate validation. |
| Server-side price/risk freshness | Eligibility now requires market and risk fetch timestamps no more than 30 seconds old and no more than 5 seconds in the future. Missing, stale, or future-dated timestamps fail closed. | These timestamps and the price/risk values are still trusted-caller inputs; they are not yet sourced from a trusted scanner/RPC pipeline or wired into the Worker. |
| Runtime integration | `live-trading.mjs` performs inspection only and `executeLiveOrder()` throws. | `worker.js` does not import or expose the live-trading module; no trusted allow-list, semantic validators, or ALT resolver are configured by the Worker. Keep this isolation. |

## CPI outer-instruction binding hardening (PR #17 follow-up)

The CPI validator now requires a trusted, explicit list of outer instruction indexes whose inner-call trace is expected. For the Metis order path, the caller supplies only the exact decoded Jupiter V6 instruction index. The validator rejects CPI groups attached to other outer instructions, duplicate groups, empty groups, missing expected groups, malformed indexes, and unapproved inner programs/accounts. This prevents a CPI trace for an unrelated top-level instruction from satisfying the Metis route's DEX-program checks.

Regression tests cover wrong outer indexes, duplicate and empty groups, and missing expected groups. This hardening narrows the trace binding but does not prove DEX-specific CPI account semantics, pool/vault/PDA relationships, or that simulation will match later execution. Those remain blockers and require independent protocol review.


## Trusted RPC + strict Jupiter V6 Metis inspection (PR #17 follow-up)

The branch now has a pinned HTTPS JSON-RPC client in `solana-trusted-rpc.mjs`. It rejects endpoint substitution, credentials/query strings, malformed JSON-RPC responses, oversized payloads, and RPC context regressions. The client reads the exact source/destination token accounts with `getMultipleAccounts(jsonParsed)` and a `minContextSlot`, then simulates the exact returned unsigned Base64 transaction with signature verification disabled and inner-instruction tracing requested. The simulation is bound to the decoded transaction's account-index space; all CPI programs/accounts must be on separate trusted allow-lists, and every DEX program required by the decoded route must appear in the CPI trace.

`solana-metis-validator.mjs` implements a deliberately narrow Jupiter V6 validator for the `sharedAccountsRouteV2` instruction only. It pins the Jupiter V6 program ID and instruction discriminator, decodes the Borsh route vector and trailing input/output amount, slippage, and fee fields, checks the dedicated signer and writable source/destination token accounts, binds input/output mints and amount metadata to the requested quote, and requires a trusted per-swap-variant DEX program/label mapping. Other Jupiter instruction variants are rejected. The initial account policy supports classic SPL Token accounts and wrapped SOL; Token-2022 swap accounts are rejected pending mint-level extension and program-specific account validation.

The RPC inspection and Metis validator are now called from `getJupiterOrder` before inspection metadata can be returned. They are not imported or exposed by `worker.js`; no live-order path, signing, or submission was added. The DEX program/label maps and CPI allow-lists remain caller-supplied trusted server policy and have no approved production values. Do not derive them from Jupiter responses, browser data, or routePlan.

**Important remaining limits:** this is a strict validator for one Jupiter V6 instruction shape, not blanket approval of all Metis routes. The deployed program/IDL version must be independently matched to the current Mainnet binary; every DEX variant mapping and account layout needs independent review. The generic CPI trace checks allow-listed programs/accounts and presence of required DEX programs, but it does not prove every CPI's protocol-specific account semantics. Simulation may differ from execution because state can change. Token-2022 mint extensions, fee-account/PDA derivation, per-DEX pool/vault relationships, quote-to-route intermediate mint flow, and exact DEX CPI semantics remain release blockers. No production RPC was contacted by the unit fixtures.

## Test review

Node tests cover legacy/v0 decoding, static-key and ALT-loaded signer/writable metadata, ALT address-index bounds and duplicate-index rejection, resolved and unresolved ALT fixtures, malformed serialized data, unknown Program/Account rejection, signer mismatch, pre-signed transaction rejection, missing semantic validators, metadata-only order results, standalone simulated-CPI trace validation, Metis-only Jupiter router and quote-field checks, gasless/fee-payer rejection, quote expiry against a trusted block-height provider, stale market/risk timestamps, and standalone parsed token-account identity/authority/slot/extension checks. Trusted-resolver unit tests cover canonical owner checks, active/deactivated state, RPC endpoint pinning, slot freshness, recent extension rejection, missing accounts, malformed state, and invalid configuration.

The positive policy test uses a deliberately permissive mock validator. It proves the validator hook is called and explicit approval is required; it does **not** validate real Jupiter, Token, Associated Token, System, or DEX instruction semantics. The ALT tests use constructed fixtures and do not prove live RPC behavior.

The CPI rejection test fixture was corrected so the unknown Program ID and account remain outside their respective allow-lists. The corrected commit's CI run must complete successfully before this test suite is considered green. A successful unit-test run does not establish production RPC trust, Worker integration, or transaction safety. The legacy `solana-smart-bot` Cloudflare check has previously failed because that old Worker name does not exist; distinguish it from the current `solana-smart-bot-new` Preview result.

## Remaining work before Stage 2 can pass

1. The trusted ALT resolver remains a standalone helper. Independently review its assumptions and validate the chosen RPC provider operationally before wiring it into trusted server configuration. Never accept resolver, RPC response, or policy inputs from browser/Jupiter-controlled data.
2. Metis validation is limited to the single `sharedAccountsRouteV2` shape. The validator pins the Jupiter V6 program/discriminator and checks route bytes, quote amounts, signer, mints, token-account privileges, and trusted per-variant DEX program/label mappings. Independently verify the exact deployed Jupiter binary/IDL and each DEX program/version/account layout; do not treat the caller-supplied maps as approved production policy.
3. Order inspection now obtains current block height from the same pinned trusted RPC client and enforces the 150-block expiry window. Continue independent review of fee-account/PDA derivation, exact quote-to-route token flow, route percentages, and any metadata not represented in the decoded instruction.
4. The trusted RPC client now exposes `getAccountInfoAndContext` using base64 `getAccountInfo`, validates the returned ALT owner/data/context, and constructs an ALT resolver bound to that same pinned RPC endpoint. `getJupiterOrder` no longer accepts a caller-provided ALT resolver; v0 transaction decoding resolves every lookup table through the RPC client supplied to the server-side order inspection. An integration test constructs a v0 transaction with a loaded writable account, serves its ALT account bytes through mocked JSON-RPC, and verifies the decoder's table provenance and writable metadata. The trusted RPC helper also reads the actual source/destination token accounts and simulates the exact unsigned transaction before `getJupiterOrder` returns inspection metadata. It binds account reads and simulation to monotonic RPC context slots and requires explicit CPI program/account allow-lists plus an exact expected CPI program set. These checks are wired into the library order-inspection function only; no production Worker configuration or live-order execution path consumes them.
5. The semantic validator deliberately rejects Token-2022 source/destination accounts. Add mint-level Token-2022 extension checks and reviewed support only after protocol-specific account relationships are implemented.
6. CPI validation checks allow-listed inner programs/accounts and expected program presence, but does not prove every DEX CPI's protocol-specific account semantics or pool/vault/PDA relationships. Add per-DEX CPI semantic validators and adversarial fixtures before approving any route.
7. The ALT resolver is now connected to the order-inspection path through the same RPC client, with a mocked JSON-RPC v0 integration test. Remaining production work: construct that RPC client only from immutable server-side endpoint configuration, verify the provider operationally, and add a deployment-configuration test; the current Worker does not instantiate this path.
8. Expand adversarial tests for fee redirection, unexpected writable privileges, altered intermediate mints/amounts, unexpected optional/remaining accounts, CPI account substitution, stale simulation context, and malformed route data.
9. Independently verify market/risk timestamp provenance and all trusted RPC endpoint/policy configuration. Existing age checks (30-second maximum age, 5-second future skew) are not a substitute for trusted source provenance.
10. Keep the Worker isolated until immutable policy, semantic validators, CPI policy, and ALT resolver are independently reviewed and approved. No live execution endpoint may consume browser-controlled or otherwise caller-supplied policy functions/allow-lists.
11. Obtain independent security review before considering any signing or submission work.

## Safety invariant

Until every applicable item above is completed and independently reviewed, the live-trading module remains isolated, default-off, and non-executable. No merge, production deployment, wallet signing, or real transaction is authorized by this audit.


## Saber StableSwap source-derived account validator (PR #17 follow-up)

The Saber source baseline is pinned to `saber-hq/stable-swap@39d5d4e0e844a009c83d37a3ce63d219fdba0bff` (upstream master commit dated 2023-12-01). Its deployment configuration declares program ID `SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ` and an upgrade authority; this source declaration is not proof that the currently deployed Mainnet executable matches the source.

The source-defined `SwapInfo` account is exactly 395 bytes. The decoder in `solana-saber-validator.mjs` reads the initialized/paused flags, nonce, amplification values, reserve keys, token mint keys, admin fee keys, and eight fee integers at the offsets defined by the official Rust `Pack` implementation. The candidate CPI validator checks the 17-byte Swap instruction (tag 1 plus little-endian amount-in and minimum-output), the nine-account order, the swap-authority PDA, reserve/mint relationships, classic SPL Token account ownership, vault authority, admin-fee destination, source balance, and account privilege constraints.

The trusted RPC client now provides bounded `getMultipleRawAccountInfos` reads using base64, a pinned HTTPS endpoint, a minimum context slot, strict owner/metadata checks, a 512 KB per-account data ceiling, and a 16-account request ceiling. Tests cover valid raw account reads and malformed, stale, oversized, or incomplete responses. Saber validator tests include positive and negative synthetic account fixtures; they do not query Mainnet or Devnet.

**Saber remains explicitly blocked.** The candidate validator is not wired into the Metis route validator or Worker. A Jupiter CPI's user-authority PDA and inner-account privileges must be bound to independently verified Jupiter route semantics before integration. The deployed Saber program account and ProgramData must be read from Mainnet, the executable hash and upgrade authority verified, and source-to-binary equivalence established (or the binary independently audited). Then add Devnet positive/negative integration tests using only test tokens and no real funds. Until all those gates pass, no Saber route is approved for live transactions.


### Saber swap direction correction

The official Rust `swap()` constructor defines accounts 4 and 5 as `swap_source` and `swap_destination`, not permanently as token-A reserve then token-B reserve. The processor selects the direction by comparing account 4 to token-A or token-B reserves, and validates account 5 plus account 7 against the opposite token's reserve and admin-fee account. The candidate validator now applies this directional ordering for both A-to-B and B-to-A and includes a reverse-direction positive fixture. It still remains disconnected from production policy and is not a binary-verification result.


### Mainnet executable provenance remains unverified

A public program-index page currently labels this Saber program's binary **Unverified Binary** and reports an upgrade authority of `EVmbDJCTGeExFGUKxmZwrfnzw4zpf7SPhPgfiLDJkUEVO`, a last-deployed slot of `119721738`, and a canonical hash. The upstream repository's `stable-swap-program/scripts/deployment_config.json` instead lists `GSmjrpT8zNtp6Ke8y2xS5P1kREEjqZCjwxF8VbxDJAV8` as upgrade authority. These are not reconciled facts: the explorer is a third-party index and the repository file is a source-side deployment config, neither substitutes for a fresh Mainnet RPC read. Treat the discrepancy as an explicit verification blocker.

Required next evidence: fetch the program account on Mainnet; verify its owner is the upgradeable BPF loader and it is executable; decode its ProgramData address; fetch ProgramData and decode deployment slot and upgrade authority; hash the executable bytes; run a reproducible build of the pinned Saber source commit using its exact toolchain/dependencies; compare the on-chain executable hash to the locally built executable using the Solana Verify tooling. Solana's official verification guide describes the hash comparison and notes that verification proves source-to-binary correspondence, not program safety. Do not enable Saber based only on a program explorer listing or a source repository.


### CPI semantic-validation integration gap

The current `dexSemanticValidatorsBySwapVariant` callback runs synchronously inside `validateMetisJupiterV6Instruction`, before `inspectMetisOrderWithTrustedRpc` simulates the transaction. Its input contains the decoded outer transaction and Jupiter route-plan metadata, but not the trusted simulation's inner CPI instruction data or raw pool/vault account state. Separately, `inspectMetisOrderWithTrustedRpc` currently checks CPI program/account allow-lists and returns program IDs; it does not fetch Saber pool state or invoke the Saber candidate validator.

The CPI policy now preserves the validated inner-instruction sequence, outer instruction index, program ID, ordered account keys, and bounded instruction data. This is only a data plumbing step. The next safe implementation must move DEX-specific *account-semantic* validation to a post-simulation stage: identify the exact Saber inner instruction under the pinned Jupiter outer instruction; fetch its swap account to discover the two mint addresses; then fetch the complete required account set together at a context slot no older than the simulation; bind the CPI user-authority PDA to the actual inner instruction and Jupiter's official authority derivation; and only then call the source-derived Saber validator. Missing or ambiguous CPI instructions, stale/mixed account snapshots, unsupported authority derivation, or any unverified program binary must reject the route. Do not treat the existing pre-simulation callback as equivalent to this post-simulation verification.


### Jupiter authority must be pinned before Saber can be accepted

The Jupiter `sharedAccountsRouteV2` IDL distinguishes `programAuthority` (account index 1) from `userTransferAuthority` (account index 2). Jupiter's source helper derives program authorities from the `authority` seed plus a one-byte authority index. The current `jupiter-amm-implementation` source at `cc068c9d1df0060c62f9a8a4fc37ea13ea7b9b39` declares 16 authority PDAs, while the archived `jupiter-cpi` helper at `12bc5f67b94a2c3edc74d6e721a19442124a0bad` declares 8. This is a source-version discrepancy, not proof of the exact authority set accepted by the currently deployed Jupiter V6 binary.

Therefore the Saber validator must not receive the user's wallet as a guessed `expectedUserAuthority`. The actual Saber CPI authority must be matched against the exact Jupiter program-authority account and the authority derivation/range from the verified deployed Jupiter source. The source commit and executable verification for Jupiter V6 are dependencies of this check. Until this is resolved, the candidate Saber validator remains test-only and disconnected.


### Upgradeable-loader ProgramData parser and trusted RPC read

A new `solana-upgradeable-program.mjs` parser now validates the upgradeable-loader Program account (state discriminator 2, executable, exact 36-byte pointer) and ProgramData account (state discriminator 3, non-executable), reads the deployment slot and optional upgrade authority, checks the ELF magic at the correct header offset, and computes a SHA-256 digest of the bytes returned by RPC. It deliberately does not claim that this raw SHA-256 is the same as the canonical executable hash reported by a program explorer or `solana-verify`; canonicalization and source-build comparison must use the official verification tooling.

The trusted RPC client exposes `inspectUpgradeableProgram(programId)`. It reads the Program pointer, then fetches Program and ProgramData together at a context slot no older than the first read, rejecting a changed pointer or malformed account snapshot. The raw account data limit was raised from 512,000 to 1,000,000 bytes because the public Anchor.so listing reports this Saber ProgramData account at 609,792 bytes; the overall JSON-RPC response ceiling remains 2 MB. Positive/negative tests cover the loader state, authority option, ELF header, pointer consistency, and a 610,000-byte synthetic executable fixture.

### Build provenance findings

At the pinned Saber source commit `39d5d4e0e844a009c83d37a3ce63d219fdba0bff`, `Anchor.toml` pins Anchor `0.24.2` and Solana `1.11.10`; the program crate declares version `1.8.2`, and the repository has a Cargo.lock and Nix flake lock. The Nix environment includes Anchor `0.24.2`. The repository's `do.sh e2e-test` path builds and runs the program on a local validator, so that script alone is not a Mainnet binary verification. The Anchor.so listing shows historical release `v1.8.1`, while the current source crate reports `1.8.2`; this is another version provenance point to reconcile rather than assume away.

The Anchor.so page reports the program as **Unverified Binary**, canonical hash `c1e843d5134d3c93105f111629c364db4b8bc7aba109cc79e3b7e4b73c149c38`, upgrade authority `EVmbDJCTGeExFGUKxmZwrfnzw4zpf7SPhPgfiLDJkUEVO`, and deployment slot `119721738`. The source-side deployment config lists `GSmjrpT8zNtp6Ke8y2xS5P1kREEjqZCjwxF8VbxDJAV8`; that file does not establish the current on-chain authority. The exact Mainnet account bytes and ProgramData metadata have not yet been fetched from a trusted Mainnet RPC in this environment, and the on-chain canonical hash has not been matched to a reproducible build. **Binary verification remains blocked.**

Latest CI for the earlier fully integrated source commit `01494649a81f6db6d0800756ba53dd988bf22aa8` completed successfully. CI for the newer ProgramData parser/RPC additions must also complete successfully before treating those additions as tested. PR #17 remains open and unmerged; production Worker remains unchanged.


### Direct Mainnet RPC snapshot (read-only; 2026-11-11)

The new GitHub Actions audit successfully read the live Mainnet program through the official public Solana Mainnet RPC using `getMultipleAccounts` with `finalized` commitment. Snapshot context slot: `467914880`.

Observed on-chain metadata:
- Program ID: `SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ`
- ProgramData address: `54aePuBcYcf8G3CDrWWd2MEiw6Q7UGy2kjgQBDhqoMdt`
- Deployment slot: `119721738`
- Upgrade authority (direct RPC): `EVmbDJCTGeExFGUKxmZwrfnzw4zpf7SPhPgfiLDJkUEV`
- Immutable: `false`
- ELF bytes returned after the ProgramData header: `609792`
- Raw SHA-256 over those returned ELF bytes: `383f720f2e0d47ce616dfda2f9f263ccd83fc6d38a2629b472dcbfad9dfb4504`

The OSEC Verified Builds status endpoint returned HTTP 200 and explicitly reported `is_verified: false`, `message: "On chain program not verified"`, blank `on_chain_hash` and `executable_hash`, and no repository/commit verification record. This is direct evidence that the program is currently not verified by that service. The direct RPC authority differs from the source repository's deployment-config value `GSmjrpT8zNtp6Ke8y2xS5P1kREEjqZCjwxF8VbxDJAV8`; the live chain value is the one to use for current metadata.

The raw SHA-256 above is **not** asserted to equal the canonical hash reported by Anchor.so or by `solana-verify`; the ProgramData allocation may include padding and the canonicalization rules are tool-specific. The next binary gate is to run the official `solana-verify get-program-hash` against this Mainnet program and then perform a reproducible `verify-from-repo` build at the pinned Saber source commit/toolchain. No signing or transaction submission occurred during this audit.

The read-only Mainnet audit workflow completed successfully on commit `b60285acd9cb8cdb481c9408cf0d60b60eef06b2`. Separately, Node safety tests passed **77/77** on commit `7c1f8d7c238bb151b9a083ab7ee4be7701b2cdce`. These establish the parser/RPC test behavior and live account metadata retrieval, not source-to-binary equivalence. Saber remains blocked.


### Fresh Mainnet RPC evidence (read-only audit run)

The automated Mainnet audit completed successfully on 2026-11-11 at context slot `467915130`. It fetched the actual Program and ProgramData accounts at a consistent finalized snapshot and decoded:

- ProgramData: `54aePuBcYcf8G3CDrWWd2MEiw6Q7UGy2kjgQBDhqoMdt`
- Deployment slot: `119721738`
- Current on-chain upgrade authority: `EVmbDJCTGeExFGUKxmZwrfnzw4zpf7SPhPgfiLDJkUEV`
- Executable bytes: 609,792 bytes; diagnostic raw ELF SHA-256: `383f720f2e0d47ce616dfda2f9f263ccd83fc6d38a2629b472dcbfad9dfb4504`
- OtterSec verification status: `is_verified=false`, message `On chain program not verified`

This resolves the earlier upgrade-authority discrepancy in favor of the live Mainnet ProgramData account; the repository deployment config is stale for current authority metadata. The raw ELF SHA-256 is diagnostic only and must not be compared directly with the canonical `solana-verify` executable/program hash.

A new read-only workflow, `.github/workflows/saber-reproducible-binary.yml`, pins the Saber source commit `39d5d4e0e844a009c83d37a3ce63d219fdba0bff` and Solana Verify CLI 0.5.2, builds `stable_swap` in the reproducible Docker build environment, and compares its canonical executable hash against both Mainnet and Devnet program hashes. It performs no signing, deployment, verification-PDA upload, or transaction submission. A hash mismatch or missing program fails closed. This workflow has been added but its first run must complete before any source-to-binary conclusion is made.

The existing Node safety tests and the read-only Mainnet metadata audit passed on commit `d07e45c3780e5364916dca723483261a3bdf6f9f`. That success does not imply the Saber executable is source-verified: the verification service explicitly returned `is_verified=false`.


### Post-simulation Saber CPI account binding (candidate audit path)

The trusted RPC inspection now has a separate post-simulation Saber inspection path. It requires the simulated inner CPI to be under the exact pinned Jupiter outer instruction, the Saber pool key to match the server-side quote's AMM key, and the Saber CPI user-authority account to equal Jupiter's derived `programAuthority` PDA. It reads the pool first, extracts the two mint addresses from the 395-byte SwapInfo state, then fetches all nine CPI accounts plus both mints in one bounded raw-account snapshot at a context slot no older than the simulation and first pool read. The existing source-derived Saber validator then checks pool owner/state, authority PDA, token mint/vault relationships, reserve direction, admin fee, account privileges, and amount.

Jupiter's current source helper at commit `cc068c9d1df0060c62f9a8a4fc37ea13ea7b9b39` derives `programAuthority` from `[b"authority", authority_id]` and declares 16 IDs. The validator now rejects a Jupiter shared-route account 1 that is not one of those derived PDAs; account 2 remains the user's transfer-authority signer. The Saber CPI account 2 is checked against the Jupiter program-authority PDA, not the user's wallet.

This is still a candidate audit path, not permission to execute. The pinned Jupiter deployed binary/authority range is not yet reproducibly verified; Saber remains rejected before this path can authorize a route; no DEX policy entry has been approved; and Devnet integration has not yet been run. A successful fixture test does not establish Mainnet program provenance or on-chain execution safety.


### Latest Mainnet metadata audit refresh

A second finalized read-only Mainnet RPC audit completed successfully on commit `4d2620f7fe3486919cb1592754eb7f8861e49d68` at context slot `467920334`. It independently returned the same ProgramData address, deployment slot, live upgrade authority, executable length, and raw diagnostic SHA-256 recorded above. OtterSec's verification endpoint again returned HTTP 200 with `is_verified=false` and `On chain program not verified`. Thus the ProgramData metadata is repeatable across two snapshots, but the deployed executable is still not source-verified.

The reproducible-build workflow currently pins Solana Verify CLI `0.5.2` (not 0.6.0), upstream Rust `1.59.0`, Saber source commit `39d5d4e0e844a009c83d37a3ce63d219fdba0bff`, and the source repository's Nix CI environment. The latest run has not yet completed; no executable-hash match or Devnet E2E result is claimed.
