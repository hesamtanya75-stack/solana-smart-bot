# Cloudflare Preview runtime validation checklist

Status: pending an operator-created isolated Preview deployment  
Target branch: `migration/cloudflare-only`  
Scope: Preview only; paper-trading only

This checklist is deliberately separate from the repository's in-memory tests and Wrangler dry-run. Completing CI does not prove that Cloudflare has created the Durable Object, applied its SQLite storage migration, or persisted state between requests.

## Hard safety gates

- [ ] Confirm the deployment target is a Cloudflare **Preview** deployment for `migration/cloudflare-only`, not Production.
- [ ] Confirm Preview uses KV namespace `e1c54bd4247d47ebba9c1db1fa7082e0` for `BOT_STATE`.
- [ ] Confirm Preview binds `PAPER_STATE_COORDINATOR` to `PaperStateCoordinator`.
- [ ] Confirm Production KV namespace `2e205fdb0eff44f78786e7500ae401a1` is not selected or modified by this test.
- [ ] Do not provide Deno credentials, import Deno state, run the migration helper, enable automatic buying, or perform any wallet/chain transaction.
- [ ] Keep the Deno project and its KV data intact.
- [ ] If the deployment interface offers only a Production target or cannot demonstrate Preview isolation, stop.

## Read-only smoke checks

Set `PREVIEW_URL` to the exact Preview URL shown by Cloudflare. Do not guess or reuse a production URL.

```sh
curl -i "$PREVIEW_URL/health"
curl -i "$PREVIEW_URL/version"
curl -i "$PREVIEW_URL/asset-check"
```

Expected:
- `/health`: HTTP 200 and JSON with `ok: true`, `mode: "paper-trading"`, and Durable Object paper-state storage.
- `/version`: HTTP 200 and JSON with a build identifier.
- `/asset-check`: HTTP 200 and JSON confirming the dashboard asset is present.

Record the actual URL, response status, build identifier, and timestamp. Do not publish secrets or session tokens in logs.

## Authentication and Durable Object checks

Use a dedicated Preview-only login password configured as the `BOT_LOGIN_PASSWORD` secret in the Preview environment. Never use or copy the Production password.

1. POST the Preview password to `/api/login`; if MFA is enabled, complete the configured TOTP challenge through `/api/login/totp`.
2. Keep the returned session token private and send it only as `Authorization: Bearer <token>`.
3. Confirm unauthenticated `GET /api/state` and `PUT /api/state` both return HTTP 401.
4. With the authenticated token, GET `/api/state` and record whether the Preview coordinator is initialized. Do not assume a default-looking response proves persistent initialization.
5. On a disposable Preview deployment only, verify an allow-listed state PATCH/automation update, then read state back and confirm it persisted. Keep `enabled: false` and `paused: true`; do not enable automatic paper buys.
6. Verify invalid/unknown state fields are rejected (HTTP 400).
7. Verify version conflict behavior with two commits based on the same snapshot: only one may succeed; the stale commit must be rejected (HTTP 409).
8. Repeat the read after a Preview redeploy and confirm the same Durable Object state/version remains available.
9. Confirm the Preview KV namespace and Durable Object binding remain isolated from Production.

Do not run state-mutating checks against Production. If a clean Preview coordinator cannot be guaranteed, stop before the first mutation and create a fresh disposable Preview test target using the Cloudflare dashboard.

## Cron and completion criteria

- [ ] Confirm Preview Cron behavior is understood before allowing scheduled invocations; the Worker configuration includes a one-minute Cron trigger.
- [ ] Confirm Cron does not initialize an empty paper state.
- [ ] Confirm a stale Cron result cannot overwrite a newer Preview dashboard update.
- [ ] Confirm no live-trading, signer, swap, or transaction-submission capability was enabled.

The Preview validation is complete only when the read-only smoke checks, authenticated state checks, conflict test, persistence check, and isolation checks have recorded passing evidence. Attach the evidence to the migration PR. A successful deployment alone is not a passing runtime validation.

## Explicitly out of scope

This checklist does not authorize Production deployment, Production KV access, Deno-to-Cloudflare data import, Deno retirement, PR merge, funded Devnet activity, Mainnet trading, wallet signing, or real-money transactions.
