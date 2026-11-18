# Phantom per-order approval architecture

## Status

Design gate only. This document does not enable live trading, add a live API route, sign a transaction, submit a transaction, or change the dashboard. The current Phantom integration remains read-only. The current Worker remains paper-trading only.

## Required user experience

Every buy and every sell is a separate order. The application must show the complete order review before asking Phantom to sign:

- Connected Phantom public key and requested fee payer.
- Buy or sell direction, input/output mint, token symbol and verified mint address.
- Exact input amount and minimum expected output after slippage.
- Maximum slippage, network/cluster, quote timestamp and expiry.
- Network fee, priority fee, platform/Jupiter fee, rent and any tip, with an all-in maximum debit.
- Every destination/program that can receive funds, including token-account creation and cleanup effects.
- Clear warning for unknown or unverifiable fields.

The user must click a dedicated confirmation control for that one order, then approve the exact transaction in Phantom. No standing approval, batch signing, auto-signing, background signing, or automatic retries that create a new transaction are allowed. A sell requires the same separate review and approval as a buy.

## Non-negotiable wallet model

The currently pinned `EXPECTED_BOT_WALLET` is incompatible with the requested personal Phantom-wallet flow. The browser-connected Phantom public key must become the transaction owner, fee payer, and settlement owner for that individual order. It must be re-read immediately before signing and compared with the owner in the server-issued intent. Any account change, disconnect, cluster change, expired quote, or changed transaction invalidates the review and requires a fresh order and fresh approval.

The Worker must never hold a wallet private key or ask for a seed phrase. Signing is permitted only by the Phantom provider in the browser, in direct response to the user's explicit action.

## Required trust boundaries and sequence

1. **Create intent (server):** authenticate the existing user session; accept only order inputs and the connected public key; independently fetch market/risk evidence; apply per-order, daily, liquidity, volume, token-authority, holder, and kill-switch policy. Do not trust client-supplied prices, risk flags, balances, fee estimates, or route claims.
2. **Build unsigned transaction (server):** request a fresh Jupiter order/build for the exact Phantom owner. Bind the response to a short-lived, single-use intent ID and immutable digest. Never return an executable order if semantic verification is incomplete.
3. **Decode and verify (server):** deserialize the complete legacy/v0 message, resolve every address lookup table at a sufficiently recent finalized context, then decode every instruction. Enforce a reviewed allowlist and exact argument/account constraints for the selected Jupiter router, System Program, SPL Token and Token-2022, Associated Token, Compute Budget, and any explicitly supported ancillary program. Reject unknown programs, unknown instruction variants, unexpected signers, writable accounts, token authorities, delegate changes, close-authority changes, arbitrary transfers, unreviewed tips, and unexpected SOL/token outflows. Check that route-plan mints/amounts agree with the decoded swap instructions. An address allowlist alone is not semantic verification.
4. **Present review (browser):** render the server-derived immutable order summary. The browser must not modify the transaction bytes. Show the exact wallet, network, amounts, minimum output, fees, and recipients. If any field cannot be decoded or explained, disable confirmation.
5. **Explicit Phantom approval (browser):** on a direct user click, verify the provider is still connected to the same public key and expected cluster, then request signing of that one exact message. Never call signing from timers, effects, cron jobs, or server code.
6. **Verify signed message (server):** receive the signed transaction only after the user has approved it. Deserialize it again; verify the message digest equals the approved immutable intent, all required signatures are valid, the expected Phantom wallet is the fee payer and sole expected signer, and all decoded instructions still pass the same semantic policy. Reject altered, expired, replayed, or partially signed transactions.
7. **Submit once (server):** only after all previous gates, submit the already user-signed bytes once. Do not rebuild, mutate, or silently re-sign. If the submission result is ambiguous, query the same signature and reconcile; do not blindly resubmit a different transaction.
8. **Independent settlement (server):** verify the exact signature reaches finalized status with no execution error. Verify transaction message, fee payer, owner-scoped pre/post token balances, native SOL deltas, rent, fees, tips, and all-in debit/credit against the approved intent. Update the position ledger only from independently verified settlement evidence. Failure/close transitions require equally strong proofs.

## Required coordinator changes before integration

- Remove the hardcoded bot-wallet assumption only as part of a reviewed migration to per-user wallet-bound intents; never simply replace the constant with a client-supplied address.
- Bind every reservation to authenticated user/session identity, Phantom wallet, cluster, input/output mint, exact input amount, minimum output, slippage, decoded instruction digest, quote/build expiry, and a cryptographically strong idempotency key.
- Ensure a reservation cannot be signed by another wallet or replayed by another user/session.
- Store only the minimum necessary audit and reservation metadata; never store private keys or seed phrases.
- Preserve kill-switch precedence and atomic spend/position accounting.
- Keep the Durable Object inaccessible to browsers; only authenticated Worker code may call it.
- Add explicit state transitions for approval, submission, and settlement with replay-safe idempotency. A pending reservation must not itself authorize submission.

## Current blockers confirmed in code

- `index.html` exposes only Phantom connect/disconnect and public SOL balance reads; it contains no signing or transaction-submission methods.
- `live-trading.mjs` retrieves an unsigned Jupiter V2 order, and `executeLiveOrder()` deliberately throws because execution is not implemented.
- `trusted-live-evidence.mjs` parses transaction structure and resolves lookup tables, but reports `semanticInstructionVerification: false`; it does not yet establish trust in the meaning of the complete instruction set.
- `live-trade-coordinator.mjs` fingerprints orders against a pinned bot wallet and settlement verification requires that same wallet. This is not the user's Phantom-wallet approval model.
- `worker.js` does not expose a live-order route or call the LiveTradeCoordinator. The Wrangler binding alone does not mean the coordinator is integrated.
- The existing settlement verifier requires owner-scoped SPL token deltas for the wrapped-SOL mint; native SOL wrapping/unwrapping and rent/fee effects need explicit transaction-aware verification before it can support general SOL routes.

## Acceptance gates

Do not enable live trading until all are true:

- A reviewed decoder exists for every permitted instruction/program and rejects everything else.
- Fuzz, malformed-message, unexpected-account, lookup-table, signer-substitution, fee/tip, token-account, and altered-message tests pass.
- Buy and sell flows both enforce one order = one explicit Phantom approval.
- Wallet change, session expiry, quote expiry, replay, duplicate requests, network mismatch, and ambiguous RPC submission are tested fail-closed.
- Signed-message verification is independent of the browser and occurs before submission.
- Finalized settlement verifies native SOL, wrapped SOL, SPL/Token-2022, fees, rent, and all-in costs.
- Cloudflare Worker route authentication, CSRF protections, rate limits, Durable Object authorization, and kill-switch behavior are reviewed.
- Devnet end-to-end tests use a dedicated test wallet and explicit opt-in. Mainnet remains disabled until a separate release review and explicit authorization.

## Explicitly out of scope for this design stage

No Phantom signing calls, no transaction submission, no Mainnet enablement, no production deployment, no PR merge, no Cloudflare secret/binding/KV/DO migration, and no dashboard redesign.

## Additional prerequisite: authenticated user and wallet ownership binding

The current Worker session is an administrator-style bearer session, not a per-user trading identity. Login and TOTP create a random session token whose KV record currently contains only `expiresAt`; the authorization helper checks token shape and expiry and returns a boolean. It does not return a stable user identifier or an authenticated wallet binding.

Therefore a future Phantom order flow must not treat either a browser-supplied wallet address or the existing generic session token as sufficient proof of wallet ownership. Before any order-intent endpoint is designed, the application needs an explicit identity model that:

1. Resolves the authenticated session to a stable, server-validated account identifier (without exposing session secrets).
2. Binds a Phantom public key to that account only after a fresh, domain- and nonce-bound wallet challenge is signed by the connected wallet and verified server-side.
3. Stores the wallet binding with account ownership and lifecycle metadata; account switching, disconnect, expiry, revocation, and re-binding must invalidate stale approvals.
4. Scopes every order intent, idempotency key, reservation, audit record, and settlement proof to that authenticated account and its bound wallet.
5. Re-checks the account-to-wallet binding immediately before issuing the unsigned transaction and again before accepting the signed transaction; a client-provided wallet address alone is never authoritative.
6. Keeps wallet connection/signature challenges separate from transaction signing. A challenge signature proves wallet control for binding; it is not trade approval and must never authorize a swap.

The current global session format and pinned `EXPECTED_BOT_WALLET` coordinator do not meet these requirements. Do not retrofit this by silently changing session KV records, migrating live KV data, or accepting client-supplied identities. Design and test a versioned identity/session change separately, with explicit migration and rollback review before any deployment.

This is a documented prerequisite only. No session schema, KV record, Worker route, wallet binding, signing, or transaction submission was changed by this note.

### Wallet-binding challenge protocol (future implementation)

A wallet-binding challenge is a one-time proof of control, not a transaction approval:

- The server creates a cryptographically random nonce and stores the minimum challenge state: account ID, expected origin/host, intended Solana cluster, creation time, expiry, and unused status.
- The message is a deterministic, domain-separated plain-text payload containing the application domain, a statement that this is wallet-account binding (not a trade), a non-secret account/session reference, wallet public key, cluster, nonce, issued-at time, and expiry. The browser must show the exact message before requesting the wallet signature.
- The server verifies the Ed25519 signature against the exact claimed public key and exact stored challenge bytes. It must not trust a client-supplied “verified” flag or decode an arbitrary message into a looser equivalent.
- The nonce is consumed atomically exactly once, including on concurrent requests. Expired, replayed, wrong-origin, wrong-cluster, wrong-account, or wrong-wallet challenges fail closed.
- A successful proof creates a versioned account-to-wallet binding with audit metadata. Rebinding requires a fresh challenge and explicit user-visible confirmation; it invalidates outstanding order intents and approvals for the previous wallet.
- The wallet public key is not a secret. Never store a wallet private key, seed phrase, or reusable transaction-signing capability on the Worker.

Before implementation, add tests for signature tampering, wrong key, wrong domain, wrong cluster, expired nonce, replay, concurrent replay, account switching, disconnect/rebind, and stale order-intent invalidation. Review this binding protocol independently before it can authorize any order flow.

### Versioned identity rollout plan (no live-data migration in this stage)

The current login flow issues a random bearer token and stores only `{ expiresAt }` under `session:<token>`. The authorization helper returns a boolean and does not expose a principal identifier. Do not retrofit trading identity into these existing records or infer identity from the profile endpoint, IP address, email text, or a browser-supplied value.

A future implementation should be isolated behind a new, versioned session namespace and capability gate:

1. **Define the principal source first.** Decide and document whether this installation is single-operator or multi-user. The stable principal ID must be provisioned or resolved by the server from an authenticated account registry; it must never be accepted from the request body or wallet message as an authority.
2. **Issue a new session version only after successful authentication.** A new session record should contain a schema version, opaque stable principal ID, creation and expiry times, revocation state, and the authentication assurance level. Store it under a distinct versioned key prefix. Do not rewrite, upgrade, or delete existing `session:<token>` records as part of rollout.
3. **Keep legacy sessions paper-only.** Existing sessions continue to authorize only the currently supported application features. They must not be interpreted as live-trading eligible, even if a wallet happens to be connected in the browser.
4. **Resolve identity through one server-side helper.** Replace boolean-only authorization only in a separately reviewed change with a helper that returns a typed principal/session object or denies access. Existing routes must preserve their current behavior until regression tests prove otherwise.
5. **Bind one or more explicitly approved wallet keys to the principal.** Each binding has a version, cluster, status, created/verified timestamps, and revocation metadata. The default should be one active wallet per principal unless a reviewed product requirement establishes otherwise.
6. **Require fresh step-up authentication for sensitive wallet changes.** Wallet binding/rebinding and future order creation must check the current session, required MFA assurance, wallet proof, and CSRF/origin protections independently.
7. **Keep live capability disabled by default.** A versioned identity record or valid wallet binding alone must never enable trading. A separate server-side release gate, per-order policy evaluation, reviewed instruction decoder, explicit Phantom approval, and settlement verification are all independently required.
8. **Roll out without touching production data.** First add pure schema/validation tests and isolated Worker tests with in-memory KV. Then exercise the new versioned flow in a disposable non-production environment. Any later production migration requires its own explicit authorization, backup/rollback plan, and review; it is not part of this PR task.

Required negative tests include legacy-session denial for any future live capability, missing/unknown schema version, principal substitution, expired/revoked session, MFA downgrade, wallet-binding revocation, and attempts to enable live capability by setting only a client-side flag. No route or session record is changed by this plan.
