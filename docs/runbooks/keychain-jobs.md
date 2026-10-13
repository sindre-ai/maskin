# Keychain background jobs — runbook

One page for the four Keychain jobs: the pending-undo sweeper, the legacy credential upgrade, KEK and DEK rotation, and the audit-chain snapshot with its verifier. All of them run inside `apps/dev` (croner, UTC) and are registered in `apps/dev/src/index.ts`.

| Job | File | Schedule (UTC) | On by default |
| --- | --- | --- | --- |
| Pending-undo sweeper | `apps/dev/src/jobs/keychain-undo-sweeper.ts` | every minute | yes |
| Legacy credential upgrade | `apps/dev/src/jobs/upgrade-legacy-credentials.ts` | 03:43 | **no** (flag) |
| Nightly DEK rotation | `apps/dev/src/jobs/rotate-deks.ts` | 04:23 | yes (nothing to do until credentials are read) |
| Chain snapshot and verifier | `apps/dev/src/jobs/keychain-chain-snapshot.ts` | 02:31 | **no** (needs a bucket) |
| KEK rotation | `apps/dev/scripts/rotate-kek.ts` | operator run, never scheduled | n/a |

A job tick never throws: a failure is logged and the next tick runs.

## 1. Sweeper monitoring

What it does: one `UPDATE` flips `integrations.status` from `pending_undo` to `active` and clears `undo_expires_at` where `undo_expires_at <= now()`. It never calls KMS and never touches `credentials` or `dek_ciphertext`. The window is judged by the database clock, the same clock the undo endpoint uses, so a row is either undoable or swept, never both.

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

What it does: walks `integrations` rows with `dek_ciphertext IS NULL`, decrypts under `INTEGRATION_ENCRYPTION_KEY`, re-encrypts the same value under a fresh DEK wrapped by the workspace KEK, reads the envelope back, and writes `credentials` and `dek_ciphertext` in one `UPDATE`. The decrypted value does not change.

**Flag: `KEYCHAIN_LEGACY_UPGRADE_ENABLED`, default unset (off). It must be exactly `true` to run.** The gate is in the job body, so a manual run is gated too. When off it logs `Legacy credential upgrade skipped, gate off`, touches zero rows and makes no KMS call.

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

## 3. KEK rotation and DEK rotation

Model: **rotation never moves an alias** and **nothing here ever deletes or schedules deletion of a key** (the runtime role is denied it; a human retires old keys). The first key's alias `alias/maskin-keychain-<ENV>-<workspace id>` counts as version 1; rotated keys are `<that alias>-2`, `-3`, and so on. Each old key keeps its alias, so the IAM condition on `kms:ResourceAliases` keeps matching and every DEK it wrapped still unwraps (Decrypt does not pin a `KeyId`).

### Rotate a workspace's KEK (operator, aws-kms only)

```
DATABASE_URL=... KEYCHAIN_KMS=aws-kms KEYCHAIN_ENV=staging AWS_REGION=eu-central-1 \
  pnpm --filter @maskin/dev exec tsx scripts/rotate-kek.ts <workspace-uuid>
```

Exit code 0 rotated, 2 skipped (another run holds the lock, not aws-kms, or the workspace has no KEK yet), 1 failed.

Order, so a failure keeps the old key live: take a per-workspace advisory lock (before `CreateKey`), find or create the tagged key and the alias, prove one Encrypt and Decrypt round trip on the new alias (AccessDenied is retried for up to 5 minutes while the alias propagates), and only then write `workspace_kms_aliases.kek_alias`. New wraps use the new key from that moment.

If it fails: the old alias is still in `kek_alias`, an error is logged (`Keychain KEK rotation failed; the old key stays live`) and PostHog gets `keychain_kek_rotation_failed`. Fix the cause and run it again: the same next version is computed and an existing alias is reused, never a second key.

Orphan key: a crash between `CreateKey` and `CreateAlias` leaves one tagged key with no alias (about $1 a month, only break-glass can delete it). The log line `Keychain KEK rotation created a key` carries `workspaceId`, `alias` and `keyId` for exactly this. Find it with `aws kms list-keys` filtered on the tag `maskin-workspace-id`.

Smoke (staging): rotate, then decrypt a credential wrapped before the rotation.

### Re-wrap DEKs (lazy)

Existing credentials are not re-encrypted when the alias moves. They are re-wrapped under a fresh DEK and the current alias:

- nightly at 04:23 UTC, for every envelope credential read in the last 24 hours (`credential_access_log` rows with `action = 'read'`), or
- on demand: `POST /api/integrations/{id}/rotate-dek` with the `X-Workspace-Id` header (human workspace admin or owner only). 200 rotated, 404 unknown, 409 for a legacy row (no DEK to rotate) or a row that changed mid-rotation.

Each rotation writes a `rotated` row to the audit chain in the same transaction. The nightly job attributes it to the credential's creator (there is no system actor); the `request_id` starts with `rotate-dek:nightly:` or `rotate-dek:manual:`. Legacy rows are never touched.

### Retiring an old key (human, manual)

There is **no "safe to retire" signal**: `integrations.dek_ciphertext` does not record which key wrapped it, so "no DEK still points at the old key" cannot be computed from the database. To retire key version N: wait until every credential of the workspace has been read and re-wrapped since the rotation (or `rotate-dek` each one), check that no old database backup you still need holds DEKs wrapped under it (backups keep old wrapped DEKs), then schedule deletion with the 30-day pending window in the AWS console. Do not delete earlier.

## 4. Chain snapshot and verifier

Why: the hash chain proves the audit log was not edited row by row; a copy of the head in a bucket nobody can rewrite proves it was not rewritten whole.

Config: `KEYCHAIN_WORM_BUCKET` (name of the S3 Object Lock bucket; **unset means the job does nothing**), `AWS_REGION` (default `eu-central-1`), credentials from the standard AWS chain. The runtime role has `s3:PutObject`, `s3:ListBucket` and `s3:GetObject` on `snapshots/` only, and no `PutObjectRetention`: the bucket's default retention does the locking (Governance, 1 day in staging; Compliance, 24 months in production, which nobody can undo).

Per workspace with a chain, nightly at 02:31 UTC:

1. Walk the chain from genesis (paged). Broken → PostHog `keychain_chain_verification_failed` with `kind = chain_broken`, nothing is written.
2. Read the latest snapshot (`snapshots/<workspace id>/<date>.json`, content `{"max_id": "...", "row_hash": "...", "date": "YYYY-MM-DD"}`). Its row id must exist in the chain with the same `row_hash`. Otherwise `keychain_chain_verification_failed` with `kind = snapshot_mismatch`, nothing is written.
3. If the chain has grown since that snapshot, write today's object. An unchanged chain writes nothing; a second run the same day writes nothing.

Write safety (a wrong or duplicate object can never be deleted): the key is looked up with `ListObjectsV2` using the key as the prefix, never `HeadObject`, and counts as present only when a returned `Key` equals it exactly (a longer key sharing the prefix does not); an error on the lookup, 403 included, fails that workspace and is never read as "absent"; nothing retries; and the `PUT` is conditional (`If-None-Match: *`) so two runs cannot both land.

When `keychain_chain_verification_failed` fires: treat it as a possible tamper until proven otherwise. Do not re-run the job to "clear" it. Compare the snapshot object with the row:

```sql
SELECT id, row_hash FROM credential_access_log WHERE workspace_id = '<workspace>' AND id = <max_id from the snapshot>;
```

Log lines to grep: `Keychain audit chain verification failed`, `Chain snapshot failed for a workspace`, `Chain snapshot run`.

Smoke row 19 (staging, Governance bucket): after a run, the object `snapshots/<workspace id>/<today>.json` exists and holds the chain head `max_id` and `row_hash`; a second run the same day writes nothing new; the verifier is green (no `keychain_chain_verification_failed`).

## Environment variables

| Variable | Used by | Default |
| --- | --- | --- |
| `KEYCHAIN_LEGACY_UPGRADE_ENABLED` | legacy upgrade | unset (off); only `true` turns it on |
| `KEYCHAIN_WORM_BUCKET` | chain snapshot | unset (job inert) |
| `KEYCHAIN_KMS`, `KEYCHAIN_ENV`, `AWS_REGION` | KEK and DEK rotation, snapshot region | see `.env.example` |

All are listed in `turbo.json` `globalPassThroughEnv`.
