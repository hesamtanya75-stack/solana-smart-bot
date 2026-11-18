# Wallet enrollment and unattended trading architecture

## Status and product decision

This document supersedes the earlier per-order Phantom approval design.

The requested behavior is unattended automatic buying and selling after the operator deliberately enrolls a separate trading wallet and configures strict policy. Phantom is used, if desired, for a one-time wallet-control challenge and read-only display. It is not the background signer and must not prompt for every scheduled order.

A connected Phantom browser provider cannot safely sign transactions while the user is absent. Do not bypass Phantom prompts, automate its approval UI, or store a Phantom seed phrase/private key in the browser, Worker, KV, Durable Objects, logs, or repository.

This is a design-only document. The application remains paper-trading only. It does not add a signer, live API route, transaction submission, Mainnet capability, production configuration, or dashboard changes.

## Wallet model

- Use a dedicated, separately funded trading wallet, never the operator's primary Phantom wallet or a wallet holding long-term assets.
- The operator explicitly creates/funds the wallet outside the bot and enrolls its public key. The bot must never request, generate, display, or transmit a seed phrase.
- Wallet enrollment proves control of the public key; it does not authorize a swap or provide signing capability.
- Use an isolated managed signer/HSM or separately hardened signing service. The signer must independently enforce the approved policy and expose no general-purpose signing endpoint.
- The signer must authorize only narrowly scoped swap transactions. Reject arbitrary SOL/token transfers, authority changes, delegate approvals, account closures, unknown programs, and unsupported instruction variants.
- Keep the signing authority separate from the public Worker, browser, Workers KV, Durable Objects, and deployment credentials. Never store raw private keys in those systems.
- Define explicit revocation, rotation, recovery, and emergency-disable procedures before implementation.

## One-time wallet enrollment

1. The server resolves the authenticated session to a stable server-side principal. Do not infer identity from IP address, email text, profile data, or a client-supplied account ID.
2. The server issues a cryptographically random, short-lived, single-use nonce bound to the principal, expected application origin, intended Solana cluster, and claimed wallet public key.
3. The browser displays the exact domain-separated wallet-binding message and asks Phantom to sign that challenge only.
4. The server verifies the Ed25519 signature against the exact stored message and claimed public key, then atomically consumes the nonce.
5. The server records a versioned principal-to-wallet binding with verification, cluster, status, and revocation metadata.
6. Rebinding requires a fresh challenge and explicit operator action; it revokes outstanding intents for the old wallet.

Reject expired, replayed, concurrently replayed, altered, wrong-origin, wrong-cluster, wrong-principal, or wrong-wallet challenges. A challenge signature proves wallet control only; it is never a trade approval.

## Unattended order authorization

After enrollment, each scheduled order may proceed without an individual Phantom prompt only when all server-side gates pass:

- Create an immutable, short-lived order intent bound to the enrolled wallet, principal, cluster, mint pair, exact input amount, minimum output, slippage ceiling, fee ceiling, expiry, and idempotency key.
- Independently fetch fresh market and risk evidence. Never trust client-provided price, balance, risk score, quote, route, fee, or policy result.
- Enforce explicitly configured per-order spend, daily spend, total exposure, open-position count, daily loss, liquidity, volume, price-impact, slippage, quote-age, and minimum-output limits. No permissive defaults.
- Apply mint/freeze authority, Token-2022 extension, holder concentration, mint identity, sell-route, and program allow/deny checks to buys and sells.
- The isolated signer independently verifies the immutable intent and re-evaluates policy before signing. It must reject any mismatch or unknown instruction.
- Decode the complete legacy/v0 transaction, resolve address lookup tables, and semantically verify every instruction, account, signer, writable privilege, transfer, fee, rent effect, tip, and destination against a reviewed allowlist. Program allowlisting alone is insufficient.
- Submit once. For ambiguous RPC outcomes, reconcile the same signature; never blindly construct a replacement transaction.
- Independently verify finalized settlement, including native SOL, WSOL, SPL/Token-2022 balances, fees, rent, tips, and all-in debit/credit before updating positions or P&L.

No individual Phantom confirmation is required for each order in this model. Instead, the one-time enrollment and the isolated signer's strict, server-side policy are the trust boundary. The operator must be able to pause/revoke the wallet authorization immediately.

## Strategy and emergency controls

Before any execution implementation, explicitly define:

- Automatic buy discovery and entry criteria.
- Automatic sell/exit criteria, including stop-loss and take-profit behavior.
- Maximum per-order spend, cumulative daily spend, total exposure, and open positions.
- Maximum daily realized plus unrealized loss.
- Maximum slippage and price impact; minimum liquidity and 24-hour volume.
- Token and program allowlists/denylists.
- What happens to existing positions when the emergency stop is activated.

The emergency stop must immediately block new orders. It must not silently imply liquidation. Alert on executions, rejections, limit approaches, loss-limit breaches, signer failures, and settlement discrepancies. Keep an append-only audit trail without secrets.

Pause all trading on stale market data, RPC disagreement, quote/build mismatch, failed instruction decoding, failed settlement verification, rate-limit exhaustion, signer outage, or ambiguous submission.

## Identity and session prerequisites

The current Worker session is an administrator-style bearer session, not a per-user trading identity. The current session record contains only expiry and the authorization helper returns a boolean. The current pinned bot-wallet coordinator is not a per-user wallet enrollment system.

Before any wallet-enrollment or order-intent endpoint is implemented:

1. Decide whether the installation is single-operator or multi-user and define the stable principal source.
2. Introduce a separately versioned session/identity model. Keep legacy sessions paper-only.
3. Do not silently rewrite or migrate existing production KV session records.
4. Resolve the authenticated session to a typed principal server-side.
5. Scope wallet bindings, intents, idempotency, reservations, audit records, and settlement proofs to that principal and its enrolled wallet.
6. Require step-up authentication/MFA for wallet enrollment, rebinding, revocation, and sensitive policy changes.
7. Keep live capability disabled independently of identity and wallet enrollment.

Test principal substitution, legacy-session denial, missing/unknown schema versions, expiry, revocation, MFA downgrade, wallet rebinding, and stale-intent invalidation. Any production migration requires separate authorization, backup, rollback plan, and review.

## Required implementation and test gates

- Independent review of threat model, wallet custody, signer isolation, recovery, and revocation.
- Correct one-time enrollment challenge and atomic replay protection.
- Complete semantic transaction decoder, address lookup table verification, and negative tests for every unsupported instruction.
- Independent signer policy enforcement against immutable intents.
- Buy and sell flows with finalized, owner-scoped settlement and all-in cost accounting.
- Spend, exposure, loss, slippage, liquidity, volume, token authority, Token-2022, holder, idempotency, replay, and concurrency tests.
- Failure injection for RPC outages, rate limits, stale quotes, ambiguous/partial submission, duplicate cron invocations, signer outage, and settlement mismatch.
- Emergency stop, recovery, monitoring, and rollback tests.
- End-to-end Devnet tests using a disposable funded wallet and explicit opt-in.
- Separate independent release review and explicit authorization before any Mainnet deployment or activation.

## Current implementation blockers

- `index.html` currently connects to Phantom for public address/balance reads only; it does not sign or submit transactions.
- `live-trading.mjs` retrieves unsigned Jupiter order/build data; `executeLiveOrder()` deliberately throws because execution is not implemented.
- `trusted-live-evidence.mjs` reports `semanticInstructionVerification: false`; transaction semantics are not trusted.
- `live-trade-coordinator.mjs` uses a hardcoded bot wallet and is not integrated into a Worker live route.
- The Worker has no live-order route and does not call the coordinator.
- Settlement and failure/close proof handling remain incomplete.
- Funded Devnet lifecycle validation has not been run; the workflow's funded job remains opt-in and was skipped in the latest observed CI run.

## Explicit safety boundary

Do not merge PR #40, deploy to production, enable Mainnet, submit real transactions, or change production KV/DO data as part of this design stage. Do not change the dashboard design. The current executable trading mode remains paper trading only.

### Verified Worker identity audit (2026-11-18)

The following observations were verified in `worker.js` at the current PR branch revision:

- Both password-only login and completed TOTP login create the same legacy session shape: `{ expiresAt }`. No principal identifier or session schema version is persisted.
- `authorized()` validates the bearer token, loads that record, checks expiry, and returns a boolean. It does not resolve a typed principal or distinguish a paper-only legacy session from a future trading identity.
- The profile endpoint reads and writes the single `admin_profile` record. Email and phone values in that profile are not a stable authenticated principal and must not be used as one.
- TOTP/login failure scopes are derived from the connecting IP. This is rate-limit context, not an account or principal identity.

Consequently, do not build wallet-binding or order-intent authorization on top of the current bearer-session boolean or profile fields. First introduce and test a separately versioned principal-bound session, while explicitly rejecting legacy sessions at any future trading-identity boundary. This audit is documentation only; no session records, routes, production data, or dashboard code were changed.
