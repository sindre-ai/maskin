# GitHub App — sindre-ai

The sindre-ai GitHub App is what running agent sessions authenticate as when
they open PRs, push branches, approve reviews, and merge. Its identity is a
single **installation** per GitHub org.

## Why reinstalling is dangerous

Every install (or reinstall) of a GitHub App produces a **new
`installation_id`**. The full chain of consequences:

1. Cached GitHub App installation tokens under running agent sessions were
   minted against the previous `installation_id`. GitHub silently 401s them the
   moment a new install rotates the ID.
2. Incoming GitHub webhooks are matched to Maskin integrations rows by
   `external_id = installation_id`. The old row still exists as `active` in the
   database but stops receiving events. Nothing on the surface tells you.
3. Long-running sessions that got a token at session start and try to merge
   hours later will 401 on the merge REST call while push/git operations keep
   working — they use a different credential path.

The "why" behind the guard: between April and July 2026 the sindre-ai app was
reinstalled ~7 times in 3 months (installation_id chain: 122094538 → 122644806
→ 135782881 → 135783052 → 136115583 → 137740772 → 141870781). Each reinstall
invalidated tokens in sessions that were already open. This is what
`bet/github-401-install-churn` fixes at the code level — but the human step
must also be deliberate.

## The guards in code

- **`POST /api/integrations/github/connect`** returns `409 ALREADY_CONNECTED`
  when the workspace already has an active GitHub row. Pass
  `?confirm_reinstall=1` to opt in.
- **UI "Add another" button** on `/settings/integrations` opens a confirmation
  dialog explaining the token-rotation consequences before it will POST with
  `confirm_reinstall=1`.
- **Installation webhook handler**
  (`apps/dev/src/lib/integrations/providers/github/installation-events.ts`)
  processes `installation.created` events. When it sees a new `installation_id`
  for an `account.login` that already has an active row, it marks the previous
  row `revoked` and clears matching `pending` rows.
- **Pending-integrations reaper**
  (`apps/dev/src/services/pending-integrations-reaper.ts`) deletes any
  `status='pending'` row older than 15 minutes. Every abandoned Connect click
  gets cleaned up automatically.

## Deliberate reinstall procedure

Only reinstall when you're doing one of:

- Adding a *different* GitHub org (multi-install is supported — the existing
  row on org A is not affected by an install on org B).
- Recovering from a broken installation (private key rotated, permissions
  changed, org admin revoked the app).

Steps:

1. **Snapshot the current install.** Note the current `installation_id` shown
   under the org's row in `/settings/integrations`. If you're doing this to
   recover a broken install, confirm the install is actually broken (401s on
   an `installation_id/access_tokens` mint) — don't reinstall on a hunch.
2. **Pause running agent sessions on the affected org** or wait for them to
   finish. Any session already holding a token for the current
   `installation_id` will 401 on its next REST write after the reinstall.
3. **Alert the team on Slack** so nobody starts a new agent that will get a
   token that dies the moment you click Reinstall.
4. **Open `/settings/integrations`**, click the org's row to expand it, click
   **Add another**, and confirm the dialog. That posts with
   `confirm_reinstall=1` and redirects you into GitHub's install flow.
5. **Complete the GitHub round-trip.** After GitHub redirects back, verify:
   - The org shows exactly one active row with the new `installation_id`.
   - The `installation.created` webhook fired and the previous row was moved
     to `revoked` (check the events feed for
     `reason: superseded_by_reinstall`).
6. **Resume paused sessions.** They'll mint fresh tokens against the new
   `installation_id` on their next REST call.

## What NOT to do

- Do not click Reinstall in the GitHub app UI directly on
  `github.com/apps/sindre-maskin/installations/…` to "fix" a permission issue.
  That path bypasses the confirm dialog and the token rotation still happens.
  Update permissions in place instead if possible.
- Do not delete integrations rows directly in the database. Use the disconnect
  UI (or `DELETE /api/integrations/:id`) so the audit trail and system-actor
  membership stay consistent.
- Do not manually cancel `pending` rows from a DB console — the reaper handles
  them within 15 minutes.

## Env vars

Set in `.env` and pass-through in `turbo.json`:

- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG` (default: `sindre-maskin`)
- `GITHUB_APP_PRIVATE_KEY` (PEM, literal or base64)
- `GITHUB_APP_WEBHOOK_SECRET`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
