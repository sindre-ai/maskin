# `sindre-maskin-approver[bot]` GitHub App

Author-cannot-approve gate for the auto-merge pipeline. This App is the GitHub-side identity used by the `pr-reviewer` Maskin actor to submit `APPROVE` reviews on PRs authored by `sindre-maskin[bot]`. Its capability split is the enforcement: it has **no** `contents:write`, so it cannot author code, and therefore cannot become its own author.

## Accountable owner

Sebk.

## Required scopes

| Permission     | Level | Why                                |
| -------------- | ----- | ---------------------------------- |
| `pull_requests`| write | Submit reviews and `APPROVE`        |
| `checks`       | write | Post check runs (e.g. `maskin/security-review`) |
| `contents`     | read  | Read the diff of the PR under review |
| `metadata`     | read  | Required by GitHub on every App     |

**Explicitly denied:** `contents:write`. The approver must not be able to push commits.

## Webhook events

- `pull_request`
- `pull_request_review`
- `check_run`

Webhook URL: `https://maskin.sindre.ai/api/webhooks/github`

## Registering the App

The configuration-as-code form of this App lives at [`.github/apps/sindre-maskin-approver.manifest.json`](../../.github/apps/sindre-maskin-approver.manifest.json). Use the GitHub App **manifest flow** so the scopes and webhook config above are applied automatically:

1. Sign in to GitHub as a `sindre-ai` org admin.
2. Visit `https://github.com/organizations/sindre-ai/settings/apps/new?state=approver-bootstrap` and POST the manifest JSON, **or** use the helper script `scripts/register-approver-app.sh` (TBD) which opens the same flow with the manifest pre-filled.
3. After creation, GitHub returns to the redirect URL with a one-time `code`; exchange it for the App's credentials via `POST /app-manifests/:code/conversions`.
4. From the resulting payload, capture:
   - `id` → store as Maskin secret **`GITHUB_APP_REVIEWER_ID`**
   - `pem` → store as Maskin secret **`GITHUB_APP_REVIEWER_PEM`**
   - `webhook_secret` → store as Maskin secret **`GITHUB_APP_REVIEWER_WEBHOOK_SECRET`**
5. In the App's settings page, add Sebk as the named accountable owner in the description field.
6. Install the App on `sindre-ai/maskin` (and any other repos in scope for the auto-merge pipeline).

## Verifying the registration (Definition of Done)

```bash
# 1. App is installed on the repo
gh api /repos/sindre-ai/maskin/installation \
  | jq '.app_slug, .permissions'
# expect: "sindre-maskin-approver" and {pull_requests:"write", checks:"write", contents:"read", metadata:"read"}

# 2. Webhook is delivering to the platform
# (check the App's "Advanced" tab in GitHub → recent deliveries should be 200s
# from a pull_request event on a throwaway PR)

# 3. Smoke test: the App can submit a review on a throwaway PR.
# Get an installation token, then:
curl -X POST \
  -H "Authorization: Bearer ${INSTALLATION_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/sindre-ai/maskin/pulls/${PR_NUMBER}/reviews \
  -d '{"event":"COMMENT","body":"smoke test from sindre-maskin-approver[bot]"}'
# expect: 200 with the review object echoed back, authored by sindre-maskin-approver[bot]
```

## Rotation

Per the parent bet, credentials rotate weekly. The rotation procedure regenerates the private key in the App's settings page, updates `GITHUB_APP_REVIEWER_PEM` in Maskin secrets, and revokes the previous key only after the new key has been observed working in a session.

## Related

- Parent bet: *Auto-merge low-risk PRs into main — risk classifier + PR approver agent* (`bb682faa`)
- Companion actor task: *Provision the `pr-reviewer` Maskin actor* (`ca5d8e46`)
- Companion config task: *Define protected paths and risk floors in `.maskin/`* (`72f41a94`)
