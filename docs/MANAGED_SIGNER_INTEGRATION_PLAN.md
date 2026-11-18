# Managed signer integration plan

## Decision and scope

Use a dedicated, separately funded trading wallet with an isolated managed signer (or HSM-backed signing service) for any future unattended strategy execution. The primary Phantom wallet is never enrolled as the bot's unattended signing key.

This document is an implementation plan only. It does not add a signer integration, secret, live Worker route, transaction signing/submission, Mainnet capability, deployment, or funded test. Paper trading remains the only executable trading mode.

## Required custody boundary

- Create/enroll a new trading wallet through the selected signer provider's supported custody workflow. The operator independently verifies the wallet address before enrollment.
- Never request, display, store, or transmit a Phantom seed phrase or private key.
- Do not store raw signing material in browser storage, Worker variables, Workers KV, Durable Objects, source code, logs, or CI secrets.
- The Worker may request a narrowly scoped signing operation from the isolated signer, but must not receive exportable key material.
- Provider credentials must be scoped to the single enrolled wallet and minimum required signing operation; keep them outside source control and rotate/revoke them through the provider's control plane.
- The signer must independently validate the immutable order intent and transaction message. It must not trust a client-supplied approval boolean or an unverified Worker assertion.

## Required signer contract

The integration must expose only a narrow operation equivalent to:

`signApprovedSwap({ wallet, cluster, messageDigest, intentId, expiresAt })`

The signer must reject unless all of the following are independently verified:

1. Wallet and cluster exactly match the enrolled trading wallet and configured cluster.
2. The message digest matches the immutable, unexpired server-side order intent.
3. Every instruction, account role, signer/writable privilege, destination, token movement, fee, rent effect, and tip is covered by a reviewed semantic verifier.
4. The order satisfies per-trade spend, cumulative daily spend, exposure, position-count, loss, liquidity, volume, price-impact, slippage, token-risk, mint/freeze-authority, Token-2022, and allowlist policies.
5. The intent has not been signed or submitted before; idempotency and replay protection are enforced atomically.
6. Unknown programs, unsupported instruction variants, stale quotes, RPC disagreement, incomplete lookup-table evidence, or ambiguous state fail closed.

No generic message-signing, arbitrary transaction-signing, transfer, delegate approval, authority-change, account-close, or withdrawal API may be exposed to the strategy.

## Execution and settlement boundary

- Build a short-lived immutable intent binding wallet, cluster, input/output mints, exact input, minimum output, slippage ceiling, fee ceiling, quote expiry, message digest, and idempotency key.
- Verify the complete legacy/v0 transaction and resolve all lookup tables before requesting a signature.
- Submit at most once. On ambiguous RPC response, reconcile the same signature; never create a replacement transaction blindly.
- Independently verify finalized execution and owner-scoped SOL, WSOL, SPL, and Token-2022 balance changes, network/priority fees, rent, tips, and all-in debit/credit.
- Update the position ledger only after finalized settlement proof.
- Apply identical policy and verification gates to buys and sells.

## Required rollout sequence

1. Select and review a managed signer provider, custody terms, recovery, revocation, audit logs, availability, and supported Solana transaction formats.
2. Complete the semantic transaction verifier and negative test matrix. Current parser output is analysis-only and must not be promoted to trusted evidence.
3. Implement and unit-test the narrow signer adapter behind a disabled feature flag, with mocked provider responses only.
4. Prove signer-side independent policy enforcement and message-digest binding using provider sandbox/test facilities, if available.
5. Complete non-production end-to-end buy/sell lifecycle tests with a disposable wallet only after a separate explicit approval and test plan.
6. Complete failure-injection, idempotency, replay, concurrency, emergency-stop, settlement, and recovery tests.
7. Obtain a separate release approval before any Mainnet signer enrollment, production deployment, or live trading.

## Current blockers that remain closed

- No semantic transaction attestation for complete Jupiter swap routes or CPI effects.
- No isolated signer adapter or signer-side policy enforcement.
- No live Worker execution route.
- No implemented transaction submission or complete finalized settlement state machine.
- No funded Devnet lifecycle evidence for the current PR checks.

CI success, Phantom read-only connection, and syntax-only instruction decoding do not satisfy these blockers. Keep live trading disabled, keep PR #43 draft, and do not merge or deploy as part of this plan.


## Preparation authorization and current evidence — 2026-11-18

The user authorized continued preparation for eventual real-money trading. This authorization is not permission to create/fund a wallet, enroll a signer, sign or submit a transaction, deploy to production, merge a PR, or enable Mainnet.

PR #43 head `7e5261bf4f5d7955c359b0d0f66720d4f82b7b95` passed Node tests (run `44395541512`), Cloudflare Worker build validation (run `44395541434`), and Devnet read-only validation (run `44395541377`). The funded Devnet lifecycle job was skipped. These checks do not prove signing or execution readiness.

Next implementation dependency: select and review a managed signer provider and its Solana transaction policy/custody model. Until a provider is selected, implement only provider-neutral validation and mocked adapter tests; never accept or store raw wallet key material. The semantic verifier, isolated signer enforcement, live Worker route, transaction submission, complete settlement, and funded disposable-wallet lifecycle remain unimplemented.


## Signer provider selection — 2026-11-18

The user approved **Turnkey as the selected provider candidate** for the dedicated bot-wallet signer. This is a provider-selection decision for preparation only; it is not authorization to create or enroll a wallet, open/fund an account, configure credentials, sign or submit transactions, deploy, merge, or enable Mainnet.

### Why Turnkey is the current candidate

- Solana's TypeScript `@solana/keychain` integration documents Turnkey as a supported signing backend.
- Turnkey documents a Solana policy engine capable of transaction-level controls, including amount, address, and program-interaction policies.
- These capabilities appear relevant to a narrowly scoped unattended trading signer, but they do not establish that this repository's exact Worker runtime, transaction format, or desired policy model is compatible.

### Mandatory provider validation before any integration

1. Review Turnkey's current custody/key-management model, wallet recovery, revocation, audit trail, availability, pricing, regional/service constraints, and account requirements.
2. Confirm the exact Solana transaction formats and signing API supported by the chosen Turnkey product and the `@solana/keychain` adapter version.
3. Run a no-secret, mocked compatibility spike against the repository's Cloudflare Workers runtime and pinned dependency graph. Do not add provider credentials or key material.
4. Define independent signer-side policies for the dedicated wallet, approved cluster, exact immutable intent digest, per-trade and daily all-in spend, token/program allowlists, and emergency revocation.
5. Review policy bypass cases and confirm the provider enforces the policy on the transaction being signed, not merely on caller-supplied metadata.

Until these checks are reviewed, do not install a provider SDK, create a Turnkey organization, enroll a wallet, request credentials, or expose a signing endpoint. Continue with provider-neutral semantic verification and mocked adapter contract tests only.

### CI evidence at selection time

PR #43 head `29e9a2b129e2ed8da28160d157386d49e4be2a8e`:
- Node tests: run `44396066751` — success.
- Cloudflare Worker build validation: run `44396066578` — success; build only, no deployment.
- Devnet read-only validation: run `44396066564` — success.
- Funded Devnet lifecycle job `135126644427` — skipped.

The combined status still reports the Deno Deploy context `deploy/hesamtanya75-stack/solana-smart-bot-17` as failure. This is not evidence of a successful production deployment. The three successful workflows above do not prove signer integration or live-trading readiness.


## Turnkey / Solana Keychain compatibility review — 2026-11-19

### Verified upstream facts

- Solana's official Keychain documentation lists Turnkey as a supported TypeScript backend and describes the TypeScript signing interface as compatible with `@solana/kit` and `@solana/signers` 8.1+.
- The TypeScript quick start signs an already-compiled transaction through `signTransactionWithSigners`; the provider adapter is not a semantic transaction verifier.
- Solana's backend-selection guide categorizes Turnkey as non-custodial key management for programmatic, policy-gated signing. It distinguishes ordinary sign-and-return from backends that rewrite or broadcast transactions.
- The current repository's `package.json` does not include `@solana/kit`, `@solana/signers`, `@solana/keychain`, or the Turnkey Keychain adapter. Its current Solana dependency is `@solana/addresses@8.6.0`.
- The current `wrangler.jsonc` does not declare the `nodejs_compat` compatibility flag. The repository has only validated its existing Worker build; it has not validated the Turnkey SDK or Keychain adapter in the deployed Worker runtime.

### Compatibility decision

**Do not install or import the Turnkey SDK or Keychain packages yet.** Official support for TypeScript does not prove compatibility with this repository's Cloudflare Workers runtime, its current Solana Kit dependency graph, or the exact serialized Jupiter v0 transaction format. No upstream source reviewed so far provides a definitive Cloudflare Workers compatibility guarantee for this combination.

### Safe next validation sequence

1. In an isolated branch or CI-only spike, pin the exact `@solana/keychain-turnkey`, `@solana/keychain` / `@solana/signers` versions and their transitive dependencies; do not add secrets or create provider resources.
2. Inspect package exports and dependency graph for Node-only modules, native bindings, filesystem access, unsupported crypto APIs, dynamic code loading, and bundle-size/runtime limits.
3. Build a Worker-only mocked adapter test using a fake signer that cannot contact Turnkey and cannot produce a valid signature. Verify the module loads and the expected transaction-signer capability is exposed in workerd.
4. Verify the signer API signs only the exact bytes/digest supplied by the immutable intent; reject message mutation, wallet mismatch, cluster mismatch, expired intent, replay, unsupported message versions, and arbitrary transfer instructions.
5. Separately test provider policy configuration using documented Turnkey sandbox/test facilities before any production organization, wallet, credential, or signer enrollment is considered.
6. Keep the real signer factory behind an absent-by-default feature flag and ensure the Worker cannot reach it while live trading is disabled.

### Important security boundary

A provider policy engine is an additional independent control, not a replacement for this application's semantic instruction verifier, all-in cost accounting, atomic daily reservation, kill switch, or finalized settlement reconciliation. Never treat provider approval or a successful signature response as proof that a swap is safe or finalized.

### Repository-specific blocker summary

- No Keychain / Turnkey packages are installed.
- No Cloudflare Workers compatibility test exists for the provider adapter.
- No semantic instruction verifier exists for the complete Jupiter route.
- No live execution route or signer call exists.
- No credentials, wallet enrollment, signing, or submission has been performed.
