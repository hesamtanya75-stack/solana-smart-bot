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

## Creating the isolated Preview

Use Cloudflare **Worker Previews**, not a production deploy or a Worker Version URL. Worker Previews require Wrangler 4.135.0 or later.

For a manual deployment from this branch, use:

```sh
npx --yes wrangler@4.135.0 preview --name pr-47 --json
```

The command must run with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` supplied through the operator's secure environment. Never print either value. Do not use `wrangler deploy`, `wrangler versions upload`, or a Production environment for this checklist.

The current `previews` configuration maps `BOT_STATE` to the dedicated Preview KV namespace and declares the paper-state and auth-rate-limit Durable Object bindings. Cloudflare creates separate Durable Object namespaces/storage for each Preview. Confirm the resulting Preview's bindings in Cloudflare before any authenticated state mutation.

Configure a dedicated Preview-only `BOT_LOGIN_PASSWORD` secret with Cloudflare's Preview secret workflow. Do not copy the Production password. If the Preview requires MFA, use a separate Preview admin profile; do not copy Production MFA secrets or profile data.

**Cron limitation:** Cloudflare Cron Triggers do not target Worker Previews. Do not treat a Preview smoke test as Cron runtime validation. Validate Cron logic through the isolated automated tests and retain the separate checklist item as an explicit limitation.

If this repository is connected to Cloudflare Workers Builds and Preview Builds are enabled, a pull-request update can create the Preview automatically using the configured Preview command. Verify that the command is `npx wrangler preview` and that the Preview URL is reported before proceeding.

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
2. If the Preview admin profile says MFA is enabled but its TOTP secret is missing or blank, confirm password login fails closed with HTTP 503 and creates neither a session nor an MFA challenge.
3. Confirm `/api/login/totp` rejects backup-code authentication when MFA is disabled or its TOTP secret is missing; no session may be created.
4. Keep the returned session token private and send it only as `Authorization: Bearer <token>`.
5. Confirm unauthenticated `GET /api/state` and `PUT /api/state` both return HTTP 401.
6. With the authenticated token, GET `/api/state` and record whether the Preview coordinator is initialized. Do not assume a default-looking response proves persistent initialization.
7. On a disposable Preview deployment only, verify an allow-listed state PATCH/automation update, then read state back and confirm it persisted. Keep `enabled: false` and `paused: true`; do not enable automatic paper buys.
8. Verify invalid/unknown state fields are rejected (HTTP 400).
9. Verify version conflict behavior with two commits based on the same snapshot: only one may succeed; the stale commit must be rejected (HTTP 409).
10. Repeat the read after a Preview redeploy and confirm the same Durable Object state/version remains available.
11. Confirm the Preview KV namespace and Durable Object binding remain isolated from Production.
12. Verify `POST /api/logout` invalidates the session and that the same token is rejected afterward.
13. When enabling MFA on the disposable Preview admin profile, verify the previous session is rejected after activation, the one-time backup code is displayed once, and a fresh password-plus-TOTP login succeeds. An incorrect TOTP setup code must not revoke the active setup session.

Do not run state-mutating checks against Production. If a clean Preview coordinator cannot be guaranteed, stop before the first mutation and create a fresh disposable Preview test target using the Cloudflare dashboard.

## Cron and completion criteria

- [ ] Confirm Preview Cron behavior is understood before allowing scheduled invocations; the Worker configuration includes a one-minute Cron trigger.
- [ ] Confirm Cron does not initialize an empty paper state.
- [ ] Confirm a stale Cron result cannot overwrite a newer Preview dashboard update.
- [ ] Confirm no live-trading, signer, swap, or transaction-submission capability was enabled.

The Preview validation is complete only when the read-only smoke checks, authenticated state checks, conflict test, persistence check, and isolation checks have recorded passing evidence. Attach the evidence to the migration PR. A successful deployment alone is not a passing runtime validation.

## Explicitly out of scope

This checklist does not authorize Production deployment, Production KV access, Deno-to-Cloudflare data import, Deno retirement, PR merge, funded Devnet activity, Mainnet trading, wallet signing, or real-money transactions.

## Automated Preview workflow

The repository includes `.github/workflows/cloudflare-preview.yml`. It is deliberately guarded and will publish a Preview only when all of these conditions are met:

- The pull request targets `main` and comes from a branch in this same repository (the workflow checks `github.event.pull_request.head.repo.full_name == github.repository`).
- The repository Actions variable `CLOUDFLARE_PREVIEW_ENABLED` is set to the literal value `true`.
- The repository Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are configured.

The workflow runs `npm test`, performs a Wrangler dry-run build, checks that both secrets are present without printing them, and then invokes Wrangler 4.135.0's `preview` command. It does not run `wrangler deploy` or select a Production environment. If the enablement variable is absent or false, the Preview job is skipped by design.

Before enabling it, create a Cloudflare API token with only the permissions required to publish Worker Previews for this account. Add the token and account ID as GitHub repository Actions secrets, and set `CLOUDFLARE_PREVIEW_ENABLED=true` as a repository Actions variable. Never put credentials in workflow files, commits, issue comments, or chat. Once enabled, update this PR (or synchronize its branch) to trigger the guarded workflow. A successful job and the exact Preview URL in its logs are required evidence; a skipped job is not a deployment.


After adding the repository Actions variable and secrets, note that GitHub does not rerun an earlier skipped workflow automatically. A new commit pushed to this pull request's source branch is required to emit a `synchronize` event and evaluate the Preview job again. Check the new run's result; do not treat the previous skipped run as deployment evidence.
