# Program / Account / CPI / ALT security audit — PR #17

## Scope and disposition

Reviewed branch `live-trading-policy-enforcement` at the audit starting point `51725549d39fdfe7ecafe0c557adeeda977f581e`. This is a static code and test review only. No wallet was connected, no transaction was signed or submitted, and no production deployment or merge was performed.

**Disposition: Stage 2 is NOT complete. Keep every live-execution path disabled.** The current code has useful fail-closed scaffolding, but it does not establish that a real Jupiter swap route is safe.

## Findings

| Area | What exists | Remaining blocker |
|---|---|---|
| Transaction decoding | Legacy and v0 message decoding; canonical Base64 and size checks; bounded instruction/account counts; instruction account indexes are resolved. | Decoder output does not preserve the full per-account signer/writable privilege metadata needed for a protocol-level privilege audit. |
| Program allow-list | Caller must provide a non-empty Program ID allow-list; every outer instruction Program ID must be present. | No reviewed production Program ID set is supplied or wired. Never derive it from Jupiter's response or `routePlan`. |
| Account allow-list | Caller must provide a non-empty Account key allow-list; all message keys and instruction account references must be allow-listed; dedicated signer is pinned. | No reviewed production account policy is supplied or wired. Exact token-account mint/owner, authority, writable privilege, fee destination, and token-program relationships are not established by key membership alone. |
| Semantic validation | Every invoked outer program requires a trusted validator returning exactly `{ allowed: true }`; missing, throwing, or rejecting validators fail closed. | No production protocol-specific validators exist. A test validator that returns `{ allowed: true }` unconditionally is only a harness fixture, not evidence that a swap instruction is safe. |
| CPI | Outer instruction program IDs and account references are inspected. | CPI calls are created during program execution and are not enumerated by the serialized outer message. The current decoder/policy cannot prove the inner-instruction tree. Require a protocol-aware simulation/inner-instruction inspection strategy and exact CPI allow-policy, or reject routes whose CPI behavior cannot be proven. Simulation is diagnostic, not a substitute for reviewed semantics or a guarantee against state changes. |
| Address Lookup Tables | v0 messages require a caller-supplied resolver; returned table key must match and addresses must be present; unresolved tables fail closed. | No trusted resolver is wired. The interface does not itself prove the account is owned by the canonical Address Lookup Table Program, active at the relevant slot, fetched from a trusted RPC context, or protected against stale/mismatched state. Resolver implementation must verify those properties before returning a table. |
| Runtime integration | `live-trading.mjs` performs inspection only and `executeLiveOrder()` throws. | `worker.js` does not import or expose the live-trading module; no trusted allow-list, semantic validators, or ALT resolver are configured by the Worker. Keep this isolation until independent review is complete. |

## Test review

Existing Node tests cover legacy/v0 decoding, a resolved and unresolved ALT fixture, malformed serialized data, unknown Program/Account rejection, signer mismatch, pre-signed transaction rejection, missing semantic validators, and metadata-only order results.

Important limitation: the positive policy test uses a deliberately permissive mock validator. It proves the validator hook is called and its explicit approval is required; it does **not** validate any real Jupiter, Token, Associated Token, System, or DEX instruction semantics. The ALT fixture is a constructed in-memory object and does not test RPC owner/slot/freshness verification.

The latest recorded CI for the reviewed head had Node tests successful and the current `solana-smart-bot-new` Cloudflare Preview build successful. The separate legacy `solana-smart-bot` check failed because that Worker does not exist; this is a legacy configuration mismatch, not evidence of a failure in the current Worker.

## Required work before Stage 2 can pass

1. Add a reviewed decoder representation for every account's signer/writable privileges and preserve static versus ALT-loaded key provenance.
2. Implement a trusted ALT resolver that validates canonical program ownership, active/deactivation state, lookup indexes, RPC trust, and slot/freshness constraints.
3. Select the exact supported swap protocol(s) and versions. Independently review their program IDs, instruction layouts, account ordering, token program variants, authorities, exact input/output amounts, slippage, fees, and destination accounts.
4. Implement semantic validators for those exact versions. Reject unknown instructions, optional/remaining accounts not explicitly understood, unexpected writable privileges, and any unsupported token program or extension.
5. Define and test CPI policy. Inspect simulated inner instructions/logs for the exact transaction and reject unexpected CPI programs/accounts; do not treat simulation alone as approval.
6. Wire only the reviewed, immutable policy and resolver from trusted server configuration. Do not accept policy objects, validator functions, RPC responses, or allow-lists from browser/Jupiter-controlled data.
7. Add adversarial fixtures for wrong ALT owner, deactivated/stale ALT, privilege escalation, extra writable accounts, token-account mint/owner mismatch, fee redirection, unexpected CPI, and malformed/unknown instruction data.
8. Obtain independent security review before considering any signing or submission work.

## Safety invariant

Until every item above is completed and independently reviewed, the live-trading module remains isolated, default-off, and non-executable. No merge, production deployment, wallet signing, or real transaction is authorized by this audit.
