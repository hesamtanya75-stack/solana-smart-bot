# iPhone: Recover the isolated PR #47 Preview login

This procedure changes the **PR #47 Preview only**. It does not change Production, merge the PR, or deploy Production.

## Why the password is rejected

The Worker compares the submitted login password with the secret `BOT_LOGIN_PASSWORD`. Worker Previews use their own secrets; Production secrets are not automatically copied into a Preview.

## Prepare the Preview-only secret from iPhone

The PR workflow now has a narrowly gated secret-setup step. It runs only when PR #47's branch is `migration/cloudflare-only` and the repository variable `PREVIEW_LOGIN_SETUP` is set to `true`.

1. In Safari, open the repository:
   https://github.com/hesamtanya75-stack/solana-smart-bot
2. Go to **Settings → Secrets and variables → Actions**.
3. Under **Secrets**, add `PREVIEW_BOT_LOGIN_PASSWORD`. Create a unique password for this Preview only. Do not reuse Production or Phantom/Wallet credentials.
   - The existing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets are required and were used by the Preview deployment. Never expose or paste their values.
4. Under **Variables**, add `PREVIEW_LOGIN_SETUP` with value `true`.
5. Tell me when both are saved. I can then make a small commit to PR #47 to trigger the guarded workflow. The step will set `BOT_LOGIN_PASSWORD` on Preview `pr-47` using Wrangler's Preview secret command. It will not run `wrangler deploy`.
6. After the workflow finishes successfully, change `PREVIEW_LOGIN_SETUP` back to `false` in GitHub Settings.
7. Open the stable Preview URL:
   https://pr-47-solana-smart-bot-new.hesamtanya75.workers.dev
   and log in using the dedicated Preview password. If Preview MFA is enabled, use its separate Preview authenticator.

## Safety

- Never send the password, MFA code, session token, API token, or private key in chat or a GitHub issue.
- Keep the Preview bot paused and auto-buy disabled.
- Login recovery does not initialize paper-trading state. Before importing fresh state, confirm the Preview coordinator is uninitialized and the KV/DO resources are isolated.
- Keep Deno data intact. Do not merge PR #47 or change Production as part of this procedure.
