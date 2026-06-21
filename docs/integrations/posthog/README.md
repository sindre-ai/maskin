# PostHog `$exception` webhook

Maskin treats PostHog `$exception` events as urgent workspace insights. New
exception fingerprints create an `insight` row; repeat occurrences bump
`metadata.occurrence_count` and `metadata.last_seen_at` on the existing one
inside a 14-day window.

The integration is the app-layer counterpart to Coolify (infra layer). Both
write insights with `metadata.urgent=true` and a stable `metadata.source` enum
that the immediate-triage trigger keys on.

## Configure once in the PostHog UI

1. In PostHog → **Data pipeline** → **Destinations** → **New destination** →
   choose **Webhook**.
2. **URL**: `https://<your-maskin-host>/api/webhooks/posthog`
3. **Method**: `POST`
4. **Headers**: add
   - `Content-Type: application/json`
   - `x-posthog-signature: sha256={{hmac_sha256(<shared-secret>, body)}}`
     (use PostHog's "HMAC SHA-256" templating; the shared secret must match
     `POSTHOG_WEBHOOK_SECRET` on the Maskin server)
5. **Body**: the default event JSON. Maskin reads `event.event === '$exception'`
   from the nested object; other events are acked and dropped.
6. **Filter**: limit to `event = $exception`. Optionally narrow to a specific
   team / environment.

## Configure on the Maskin server

Two environment variables — both also listed in `turbo.json`:

| Var | Purpose |
|---|---|
| `POSTHOG_WEBHOOK_SECRET` | Shared secret for HMAC-SHA256 signature verification on every inbound payload. |
| `POSTHOG_OBSERVABILITY_ENABLED` | Master flag (`true` / `1`). When unset, the route 200s and drops the payload so PostHog doesn't retry. |

The route returns:
- `200 { ok: true, created, updated, workspaces }` on a processed event.
- `200 { ok: true, skipped: '...' }` when the flag is off, no integration is
  connected, or the event is not `$exception`.
- `401` on a missing or invalid signature.
- `500` if the secret is not configured (PostHog will retry — fix the config).

## What the insight carries

- `title`: `PostHog exception — <type>: <message excerpt>`
- `content`: user / session / URL / browser / OS / captured-at, the stack trace
  (up to 4KB raw or first 20 frames), and a link to the GitHub search of
  merged PRs in the last 24h.
- `metadata.urgent`: `true`
- `metadata.source`: `posthog_exception` (stable enum — T3's trigger keys on it)
- `metadata.fingerprint`: `posthog_exception:<posthog-fingerprint>`
- `metadata.occurrence_count`, `metadata.received_at`, `metadata.context`
  (full structured payload incl. `merge_blame_window.since` / `until` /
  `pulls_url`).
