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

CI success, Phantom read-only connection, and syntax-only instruction decoding do not satisfy these blockers. Keep live trading disabled, keep PR #40 draft, and do not merge or deploy as part of this plan.


## Preparation authorization and current evidence — 2026-11-18

The user authorized continued preparation for eventual real-money trading. This authorization is not permission to create/fund a wallet, enroll a signer, sign or submit a transaction, deploy to production, merge a PR, or enable Mainnet.

PR #43 head `7e5261bf4f5d7955c359b0d0f66720d4f82b7b95` passed Node tests (run `44395541512`), Cloudflare Worker build validation (run `44395541434`), and Devnet read-only validation (run `44395541377`). The funded Devnet lifecycle job was skipped. These checks do not prove signing or execution readiness.

Next implementation dependency: select and review a managed signer provider and its Solana transaction policy/custody model. Until a provider is selected, implement only provider-neutral validation and mocked adapter tests; never accept or store raw wallet key material. The semantic verifier, isolated signer enforcement, live Worker route, transaction submission, complete settlement, and funded disposable-wallet lifecycle remain unimplemented.
