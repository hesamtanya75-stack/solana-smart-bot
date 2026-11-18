# Cloudflare edge rate-limiting operations guide

## Scope

This guide documents an additional edge control for the Worker API. It does not change the dashboard, Worker routes, Durable Object state, production bindings, or deployment configuration. Configure rules only after reviewing the target Cloudflare zone and the account's available WAF/rate-limiting features.

The Worker already applies transactional Durable Object limits to authentication and private API routes. Those limits are useful application controls, but they are scoped by hashed source IP and route. An edge rule adds a separate layer for request floods before they reach the Worker.

## Recommended rule design

Create separate Cloudflare rate-limiting rules for the authentication endpoints rather than one broad rule for the entire site:

- `POST /api/login`
- `POST /api/login/totp`
- `POST /api/totp/setup`
- `POST /api/totp/confirm`

Use the connecting client IP as the counting characteristic and the exact HTTP method + path as the endpoint selector. Start with a conservative threshold that is materially above normal human login and MFA use (for example, 30 requests per 10 minutes per IP), then tune using observed traffic. Use a short block/mitigation period and return a throttling response. Do not apply an aggressive global rule to all `/api/*` traffic: it can block legitimate dashboard polling and paper-trading operations.

If the Cloudflare account supports a separate rule for sensitive state-changing API routes, scope it narrowly and validate normal dashboard behavior before enabling it. Do not rate-limit static assets or read-only dashboard traffic with the authentication threshold.

## Safety and deployment checks

1. Confirm the exact production hostname and zone before creating any rule. Do not copy a rule to preview or unrelated zones.
2. Check current Cloudflare plan/feature availability; dashboard labels and supported mitigation actions can vary.
3. Begin in log/simulate mode if available. Review false positives before enabling a blocking action.
4. Verify that the Worker receives the expected `CF-Connecting-IP` header. Never trust a client-supplied `X-Forwarded-For` value as the source identity.
5. Test legitimate login, MFA challenge, TOTP setup/confirmation, logout, dashboard reads, and paper-trading requests from a small set of test clients.
6. Test repeated authentication requests from one IP and confirm the edge rule throttles them before the Worker. Confirm the Worker continues to fail closed if its AuthGuard/ Durable Object is unavailable.
7. Record the rule ID, threshold, mitigation duration, owner, review date, and rollback procedure in the operator's change log.

## Important limitations

- IP-based edge rules do not replace principal/session-aware authorization or MFA.
- Distributed requests from many IP addresses can evade per-IP thresholds; they may also create false positives for shared networks.
- Do not add a global account lockout without a separate denial-of-service analysis.
- Do not disable the Worker's Durable Object rate limits when edge rules are enabled.
- Do not add secrets, API tokens, wallet addresses, or personal data to rule expressions or logs.
- This guide does not authorize a production change. Apply and verify any Cloudflare dashboard rule separately under the operator's approval process.

## Current application boundary

The application remains paper-trading only. This edge hardening does not authorize wallet enrollment, signing, transaction submission, funded Devnet testing, Mainnet activation, production deployment, or PR merging.
