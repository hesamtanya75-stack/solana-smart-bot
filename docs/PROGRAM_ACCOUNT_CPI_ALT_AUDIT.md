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
| CPI | Outer instruction program IDs and account references are inspected. | CPI calls are created during program execution and are not enumerated by the serialized outer message. Require protocol-aware inner-instruction inspection and an exact CPI allow-policy, or reject routes whose CPI behavior cannot be proven. Simulation is diagnostic, not a substitute for reviewed semantics or a guarantee against state changes. |
| Address Lookup Tables | A standalone trusted resolver helper checks an explicitly pinned HTTPS RPC endpoint, canonical ALT Program ownership, active state, bounded table metadata, RPC context freshness, and extension-slot delay. Decoder/policy tests cover lookup resolution and index bounds. | The helper is not wired into the Worker or live-order path. Trusted endpoint/configuration still require independent operational review; constructed fixtures do not prove live RPC behavior. |
| Runtime integration | `live-trading.mjs` performs inspection only and `executeLiveOrder()` throws. | `worker.js` does not import or expose the live-trading module; no trusted allow-list, semantic validators, or ALT resolver are configured by the Worker. Keep this isolation. |

## Test review

Node tests cover legacy/v0 decoding, static-key and ALT-loaded signer/writable metadata, ALT address-index bounds and duplicate-index rejection, resolved and unresolved ALT fixtures, malformed serialized data, unknown Program/Account rejection, signer mismatch, pre-signed transaction rejection, missing semantic validators, and metadata-only order results. Trusted-resolver unit tests cover canonical owner checks, active/deactivated state, RPC endpoint pinning, slot freshness, recent extension rejection, missing accounts, malformed state, and invalid configuration.

The positive policy test uses a deliberately permissive mock validator. It proves the validator hook is called and explicit approval is required; it does **not** validate real Jupiter, Token, Associated Token, System, or DEX instruction semantics. The ALT tests use constructed fixtures and do not prove live RPC behavior.

CI status must be checked against the current PR head before treating these tests as passed. A successful unit-test run does not establish production RPC trust, Worker integration, or transaction safety. The legacy `solana-smart-bot` Cloudflare check has previously failed because that old Worker name does not exist; distinguish it from the current `solana-smart-bot-new` Preview result.

## Required work before Stage 2 can pass

1. Independently review the standalone trusted ALT resolver and its configuration assumptions; validate the chosen RPC provider operationally. Only then consider wiring it into trusted server configuration. Do not accept resolver, RPC response, or policy inputs from browser/Jupiter-controlled data.
2. Select the exact supported swap protocol(s) and versions. Independently review their program IDs, instruction layouts, account ordering, token program variants, authorities, exact input/output amounts, slippage, fees, and destination accounts.
3. Implement semantic validators for those exact versions. Reject unknown instructions, optional/remaining accounts not explicitly understood, unexpected writable privileges, and unsupported token programs/extensions.
4. Define and test CPI policy. Inspect simulated inner instructions/logs for the exact transaction and reject unexpected CPI programs/accounts; do not treat simulation alone as approval.
5. Establish quote freshness and bind validated quote amounts, mints, slippage, and fees to the exact order response. Reject missing, stale, or inconsistent quote metadata.
6. Add adversarial fixtures for token-account mint/owner mismatch, authority mismatch, fee redirection, unexpected CPI, writable privilege escalation, malformed/unknown instruction data, and stale or inconsistent quote metadata.
7. Keep the runtime isolated until reviewed immutable policy, semantic validators, CPI policy, and ALT resolver are approved. No live execution endpoint may consume caller-supplied policy functions or allow-lists.
8. Obtain independent security review before considering any signing or submission work.

## Safety invariant

Until every applicable item above is completed and independently reviewed, the live-trading module remains isolated, default-off, and non-executable. No merge, production deployment, wallet signing, or real transaction is authorized by this audit.
