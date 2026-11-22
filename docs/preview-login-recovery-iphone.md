# iPhone: Recover the isolated PR #47 Preview login

This procedure changes **only the PR #47 Worker Preview**. Do not change Production secrets, merge the PR, or deploy Production.

## Why the login is rejecting the password

The Worker checks the submitted login password against the secret named `BOT_LOGIN_PASSWORD`. Worker Previews do not automatically inherit Production secrets. A password that works on Production can therefore be rejected on Preview.

## Set a dedicated Preview-only password

1. Open Cloudflare Dashboard in Safari and go to **Workers & Pages**.
2. Select Worker **solana-smart-bot-new**.
3. Use the environment/Preview selector to choose the PR #47 Preview (name `pr-47`), not Production.
4. Open **Settings → Variables and secrets**.
5. In the selected Preview's settings, add or update a variable:
   - Type: **Secret**
   - Name: `BOT_LOGIN_PASSWORD`
   - Value: create a new, unique Preview password. Do not reuse the Production password or a wallet/Phantom password.
6. Save/deploy the Preview secret change. If the dashboard only offers **Previews Base**, understand that Base secrets are inherited by newly created Previews; they may not update an already-running Preview. Prefer the specific `pr-47` Preview setting when available.
7. Open the stable branch Preview URL, not an old immutable deployment URL:
   https://pr-47-solana-smart-bot-new.hesamtanya75.workers.dev
8. Sign in with the dedicated Preview password. If Preview MFA is enabled, use only its separately configured Preview authenticator.

## Safety

- Never send the password, MFA code, session token, API token, or private key in chat or a GitHub issue.
- Keep the Preview bot paused and auto-buy disabled.
- This procedure does not initialize or import paper-trading state. Check the Preview state status first; only import if the coordinator is confirmed uninitialized.
- Do not delete Deno data, change Production, or merge PR #47 as part of login recovery.
