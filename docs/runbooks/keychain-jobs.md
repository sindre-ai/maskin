# Keychain background jobs — runbook

One page for the four Keychain jobs: the pending-undo sweeper, the legacy credential upgrade, DEK rotation, and the audit-chain snapshot with its verifier. All of them run inside `apps/dev` (croner, UTC) and are registered in `apps/dev/src/index.ts`.

| Job | File | Schedule (UTC) | On by default |
| --- | --- | --- | --- |
| Pending-undo sweeper | `apps/dev/src/jobs/keychain-undo-sweeper.ts` | every minute | yes |
| Legacy credential upgrade | `apps/dev/src/jobs/upgrade-legacy-credentials.ts` | 03:43 | **no** (flag) |
| Nightly DEK rotation | `apps/dev/src/jobs/rotate-deks.ts` | 04:23 | yes (nothing to do until credentials are read) |
| Chain snapshot and verifier | `apps/dev/src/jobs/keychain-chain-snapshot.ts` | 02:31 | yes (writes nothing until the chain grows) |

A job tick never throws: a failure is logged and the next tick runs.

## 1. Sweeper monitoring

What it does: one `UPDATE` flips `integrations.status` from `pending_undo` to `active` and clears `undo_expires_at` where `undo_expires_at <= now()`. It never uses the master key and never touches `credentials` or `dek_ciphertext`. The window is judged by the database clock, the same clock the undo endpoint uses, so a row is either undoable or swept, never both.

What you see when it works: for each run that swept rows, one log line `Keychain undo sweeper tick` with `rows_activated`, one `events` row per workspace with `action = 'keychain_pending_undo_activated'` (data holds `rows_activated` and `integration_ids`), and one PostHog event `keychain_credential_sweeper_activated`. A run that swept nothing writes nothing.

Is it keeping up? A row should never be `pending_undo` more than about two minutes past its `undo_expires_at`:

```sql
SELECT id, workspace_id, undo_expires_at, now() - undo_expires_at AS overdue
FROM integrations
WHERE status = 'pending_undo' AND undo_expires_at < now() - interval '2 minutes';
```

Any row here means the sweeper is not running (look for `Keychain undo sweeper started` at boot and `Keychain undo sweeper tick failed` in the logs) or the database is unreachable.

Scheduler: croner, five-field expression `* * * * *`, so the minimum interval is 60 seconds and no safety margin is applied to the window.

## 2. Legacy credential upgrade (OFF)

What it does: walks `integrations` rows with `dek_ciphertext IS NULL`, decrypts under `INTEGRATION_ENCRYPTION_KEY`, re-encrypts the same value under a fresh DEK wrapped by the master key, reads the envelope back, and writes `credentials` and `dek_ciphertext` in one `UPDATE`. The decrypted value does not change.

**Flag: `KEYCHAIN_LEGACY_UPGRADE_ENABLED`, default unset (off). It must be exactly `true` to run.** The gate is in the job body, so a manual run is gated too. When off it logs `Legacy credential upgrade skipped, gate off`, touches zero rows and wraps nothing.

**Do not enable until every direct `decrypt(row.credentials)` reader dual-reads** (`decryptStoredCredential` in `apps/dev/src/lib/crypto.ts`). Until then, "all credentials are envelope encrypted" is false. Readers found by grep on the bet branch (non-test files that decrypt an `integrations` row directly):

- `apps/dev/src/routes/integrations.ts` (lines around 156, 490, 621, 1745, 1882, 2107, 2761, 2943)
- `apps/dev/src/lib/integrations/oauth/token-manager.ts`
- `apps/dev/src/lib/integrations/providers/github/installation-recovery.ts`
- `apps/dev/src/lib/integrations/providers/linkedin-unipile/webhook.ts`, `.../operations.ts`, `apps/dev/src/routes/integrations-linkedin-unipile.ts`
- `apps/dev/src/lib/integrations/providers/slack/account-link.ts`, `.../slack/webhooks.ts`, `apps/dev/src/routes/integrations-slack-mcp.ts`, `apps/dev/src/services/slack-trigger-setup.ts`
- `apps/dev/src/services/resend-domain-verifier.ts`
- `apps/dev/src/services/loop-version-pusher.ts`

Done check for the flag flip: a grep or CI test that finds no direct `decrypt(row.credentials)` caller left, plus a both-shapes (legacy and envelope) test per reader. The follow-on task is "Move credential readers to dual-read (legacy and envelope rows)".

Deny-list (skipped even with the flag on): `gmail`, `google-calendar`, `google-meet`, `linear`, `slack`, `ubersuggest`, `github`, `linkedin-unipile`. Their refresh and reconnect paths still write the legacy form, and a legacy write into a row that already has a DEK leaves a stale DEK next to legacy ciphertext. The follow-on moves those writers to the envelope writer and then removes the list. Writers in `routes/integrations.ts` (API-key upsert) are not provider-specific, so the flag is the real gate.

Concurrency: the `UPDATE` only matches while `credentials` is unchanged and `dek_ciphertext` is still NULL, so a refresh that lands mid-upgrade wins and the row is retried next night.

## 3. Master key rotation and DEK rotation

Model: one master key, `KEYCHAIN_MASTER_KEY`, wraps every credential's data key. To rotate it, set the new key as `KEYCHAIN_MASTER_KEY` and the old one as `KEYCHAIN_MASTER_KEY_PREVIOUS`, then restart. Unwrapping tries the current key, then the previous one; wrapping always uses the current key. Nothing is re-encrypted at restart.

Existing credentials move to the new key when their DEK is re-wrapped:

- nightly at 04:23 UTC, for every envelope credential read in the last 24 hours (`credential_access_log` rows with `action = 'read'`), or
- on demand: `POST /api/integrations/{id}/rotate-dek` with the `X-Workspace-Id` header (human workspace admin or owner only). 200 rotated, 404 unknown, 409 for a legacy row (no DEK to rotate) or a row that changed mid-rotation.

Each rotation writes a `rotated` row to the audit chain in the same transaction. The nightly job attributes it to the credential's creator (there is no system actor); the `request_id` starts with `rotate-dek:nightly:` or `rotate-dek:manual:`. Legacy rows are never touched.

### Retiring the previous key (human, manual)

There is **no "safe to retire" signal**: `integrations.dek_ciphertext` does not record which key wrapped it. A credential nobody reads is never re-wrapped by the nightly job, so to move everything, `rotate-dek` each credential that is still unread. Then check that no old database backup you still need holds DEKs wrapped under the old key (backups keep old wrapped DEKs), and only then remove `KEYCHAIN_MASTER_KEY_PREVIOUS`. Keep a copy of the old key until then.

If the master key is lost with no copy, every envelope credential is unrecoverable and has to be entered again. Legacy credentials (no DEK) keep working: they use `INTEGRATION_ENCRYPTION_KEY`.

## 4. Chain snapshot and verifier

Why: the hash chain proves the audit log was not edited row by row; a snapshot of the head from an earlier day proves it was not rewritten from that point on. Snapshots live in the `credential_chain_snapshots` table (one row per workspace per UTC day: `max_id`, `row_hash`), and a trigger rejects `UPDATE` and `DELETE` on it. It is the same database as the log, so someone who owns the database can drop the trigger and rewrite both. That is the accepted limit of keeping this in Postgres.

Per workspace with a chain, nightly at 02:31 UTC:

1. Walk the chain from genesis (paged). Broken → PostHog `keychain_chain_verification_failed` with `kind = chain_broken`, nothing is written.
2. Read the latest snapshot row. Its `max_id` must exist in the chain with the same `row_hash`. Otherwise `keychain_chain_verification_failed` with `kind = snapshot_mismatch`, nothing is written.
3. If the chain has grown since that snapshot, insert today's row (`ON CONFLICT DO NOTHING`). An unchanged chain writes nothing; a second run the same day writes nothing.

When `keychain_chain_verification_failed` fires: treat it as a possible tamper until proven otherwise. Do not re-run the job to "clear" it. Compare the snapshot with the row:

```sql
SELECT s.snapshot_date, s.max_id, s.row_hash AS snapshot_hash, c.row_hash AS chain_hash
FROM credential_chain_snapshots s
LEFT JOIN credential_access_log c ON c.id = s.max_id AND c.workspace_id = s.workspace_id
WHERE s.workspace_id = '<workspace>' ORDER BY s.snapshot_date DESC LIMIT 1;
```

Log lines to grep: `Keychain audit chain verification failed`, `Chain snapshot failed for a workspace`, `Chain snapshot run`.

Run it once by hand: `DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/snapshot-chain.ts` (exit 0 clean, 1 on a verification failure or database error).

## Environment variables

| Variable | Used by | Default |
| --- | --- | --- |
| `KEYCHAIN_LEGACY_UPGRADE_ENABLED` | legacy upgrade | unset (off); only `true` turns it on |
| `KEYCHAIN_MASTER_KEY`, `KEYCHAIN_MASTER_KEY_PREVIOUS` | wrapping and unwrapping data keys | see `.env.example` |

All are listed in `turbo.json` `globalPassThroughEnv`.
