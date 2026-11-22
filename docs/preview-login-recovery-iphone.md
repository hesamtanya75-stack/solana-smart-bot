# iPhone: Recover the isolated PR #47 Preview login

This is for the **PR #47 Preview only**. It does not change Production, merge the PR, or deploy Production.

## Why the password is rejected

The Worker checks the submitted login against the secret named `BOT_LOGIN_PASSWORD`. Worker Previews have their own secrets; Production secrets are not automatically copied into a Preview.

## Set the Preview secret using GitHub Actions (iPhone-friendly)

A guarded manual workflow has been added:
`.github/workflows/configure-pr47-preview-login.yml`

1. In Safari, open the repository on GitHub:
   https://github.com/hesamtanya75-stack/solana-smart-bot
2. Go to **Settings → Secrets and variables → Actions → New repository secret**.
3. Add a secret named `PREVIEW_BOT_LOGIN_PASSWORD`. Choose a new, unique password for this test Preview. Do not reuse your Production or Phantom/Wallet password.
   - Existing repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` must already be configured. Do not create or paste them into chat.
4. Open **Actions** and select **Configure PR #47 Preview login secret**.
5. Choose branch `migration/cloudflare-only`, select **Run workflow**, and enter exactly `PREVIEW-ONLY` in the confirmation field.
6. Wait for the workflow to finish successfully. It uses Wrangler's Preview secret command targeting the named `pr-47` Preview. It does not call `wrangler deploy`.
7. Open the stable PR Preview URL:
   https://pr-47-solana-smart-bot-new.hesamtanya75.workers.dev
8. Sign in using the dedicated Preview password. If Preview MFA is enabled, complete only the Preview's separate MFA.

## Safety

- Never send the password, MFA code, session token, API token, or private key in chat or a GitHub issue.
- Keep the Preview bot paused and auto-buy disabled.
- Login recovery does not initialize paper-trading state. Before importing fresh state, confirm the Preview coordinator is uninitialized and its KV/DO resources are isolated.
- Keep Deno data intact. Do not merge PR #47 or change Production as part of this procedure.
