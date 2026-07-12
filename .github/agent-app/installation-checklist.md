# sindre-ai-agents GitHub App — registration + installation checklist

Purpose: give the four unattended agent identities (`github`, `github_approver`, `github-sindre-ai`, `github-vaerksted-ai`) a per-request installation-token credential path so they stop reading long-lived PATs from env vars. Follow-up work replaces the static `GITHUB_TOKEN*` values with a minting hook that reads the App id + private key parked by this task.

This checklist is written for one org admin (Magnus). The Developer agent cannot register a GitHub App itself — the click-through is org-admin-only. Everything below is a walkthrough of clicks against `github.com` plus two secret writes to Coolify.

## Before you start

- You'll need admin on the `sindre-ai` GitHub org and admin on the Coolify project the agent containers run in (`cool.sindre.ai`).
- Reference: `manifest.json` in this directory captures the exact name, description, and permissions to enter in the form. Nothing broader — the whole point of this migration is minimum scope.
- This is a **separate** App from `sindre-maskin` (the customer-facing OAuth integration). Do not reuse those keys or slug — the two Apps need independent revocation.

## Step 1 — Register the App

1. Open https://github.com/organizations/sindre-ai/settings/apps and click **New GitHub App**.
2. Fill the form from `manifest.json`:
   - **GitHub App name**: `sindre-ai-agents`
   - **Homepage URL**: `https://sindre.ai`
   - **Description**: paste the `description` field from the manifest.
   - **Webhook**: uncheck **Active**. Leave URL and secret blank. The agents don't consume webhook events — they mint tokens on demand.
   - **Repository permissions**:
     - Contents: **Read and write**
     - Pull requests: **Read and write**
     - Checks: **Read-only**
     - Metadata: **Read-only** (auto-selected)
     - Everything else: **No access**
   - **Organization permissions**: all **No access**.
   - **Account permissions**: all **No access**.
   - **Subscribe to events**: leave empty.
   - **Where can this GitHub App be installed?**: **Only on this account**.
3. Click **Create GitHub App**.

## Step 2 — Capture the App id and private key

1. On the created App's settings page, note the **App ID** (numeric, e.g. `1234567`). You'll paste this into Coolify as `GITHUB_APP_ID_SINDRE_AI`.
2. Scroll to **Private keys** → **Generate a private key**. A `.pem` file downloads.
3. Move the `.pem` to a place you'll delete after the Coolify write — do not commit it, do not paste it into Slack, do not attach it to a Maskin comment.

## Step 3 — Park the credentials in Coolify

The four agents already read env vars supplied by Coolify (see `docker/agent-base/agent-run.sh` and the current `GITHUB_TOKEN*` names). Add two new env vars to the same environment scope so follow-up work can read them the same way:

- `GITHUB_APP_ID_SINDRE_AI` — the numeric App id from Step 2.1.
- `GITHUB_APP_PRIVATE_KEY_SINDRE_AI` — the full PEM contents from Step 2.2, including the `-----BEGIN`/`-----END` lines. Coolify's env-var UI collapses newlines to spaces; the existing `parsePrivateKey` in `apps/dev/src/lib/integrations/providers/github/auth.ts` already handles that normalization, so the follow-up minting hook can reuse it.

Names deliberately differ from the customer-facing `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` — one App, one secret pair; keep the two Apps' credentials independently revocable.

After the write, delete the local `.pem` file (empty trash too — the private key is the master credential).

## Step 4 — Install the App on the covered repos

The four identities today write to:

- `sindre-ai/maskin` — this bet's repo. **Required install.**
- `sindre-ai/skjald` — named in the Code Reviewer's role. Install here too if the four identities currently touch it (they do in the Code Reviewer's system prompt). If you confirm skjald is out of scope for this bet, note that in the parent-bet reply and skip.

For each repo:

1. From the App's settings, click **Install App** (left sidebar) → **Install** next to `sindre-ai`.
2. Choose **Only select repositories** → tick the repo(s) above.
3. Confirm the permission summary matches the four bullets in Step 1.2.
4. Click **Install**.
5. Note the **Installation ID** from the resulting URL: `https://github.com/organizations/sindre-ai/settings/installations/<installation_id>`. You'll report this in Step 5.

## Step 5 — Report back on the parent bet

Post one comment on the parent bet [GitHub App per role for unattended agents](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/9e819672-7bcf-4212-b1b2-a88d83a960b5) with:

- The App id (safe to share — public identifier).
- The installation id(s) (also safe — no secret content).
- The env-var **names** the private key lives under (`GITHUB_APP_ID_SINDRE_AI`, `GITHUB_APP_PRIVATE_KEY_SINDRE_AI`) — **never** the values.

That comment unblocks T2 (mint one installation token for `github_approver` and merge one PR through it).

## What this task deliberately does NOT do

- Wire the four agents to actually mint installation tokens. T2 owns the first-pass minting for `github_approver`; T3 rolls it to the other three.
- Narrow per-request scope. T4 owns per-invocation `repositories` + `permissions` narrowing.
- Revoke the four PATs. T5 owns revocation — only after T2–T4 prove the minting path works.
- Install the App on any repo outside the four identities' current reach. If Magnus finds a repo not covered here that an agent writes to, flag it on the parent bet rather than expanding install scope silently.
