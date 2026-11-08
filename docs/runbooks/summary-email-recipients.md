# Summary email: who the recipient rule reaches (read-only)

The summary email (day 1, 3, 7 after sign-up, then weekly) picks people with one query. Run it on
production **before** the first real send and compare with the count Infra & DevOps took on
8 Nov 2026 (16 people, 10 outside the team). Anything above about 20 means a third kind of
automatic activity row is being counted: hold the first send, find the kind, leave it out in
`emailRecipientRuleSql` in `apps/dev/src/services/briefing-email-scheduler.ts`.

It only reads. It sends nothing and changes nothing.

Rule in words: a saved email choice always wins (on = receives, off = never). With no saved choice
(empty column, or no settings row) any action the person authored in the activity log in the last
30 days counts as on, except the bulk "integration created" rows and the "notification settings
created" rows. Everyone else is off. The query does not know about team accounts: remove them from
the result by address when comparing (list in the spec).

## Count

```sql
SELECT count(*) FROM (
SELECT
  a.id AS actor_id,
  a.email AS email,
  a.created_at AS created_at,
  p.actor_id IS NOT NULL AS has_row,
  p.email_digest_enabled AS email_digest_enabled,
  COALESCE(p.email_onboarding_step, 0) AS email_onboarding_step,
  p.email_last_sent_on::text AS email_last_sent_on,
  p.timezone AS timezone,
  p.briefing_time AS briefing_time,
  COALESCE(p.muted_workspace_ids, '{}'::uuid[]) AS muted_workspace_ids
FROM actors a
LEFT JOIN notification_preferences p ON p.actor_id = a.id
WHERE a.type = 'human'
  AND a.email IS NOT NULL
  AND (
    p.email_digest_enabled IS TRUE
    OR (
      p.email_digest_enabled IS NULL
      AND EXISTS (
        SELECT 1 FROM events e
        WHERE e.actor_id = a.id
          AND e.created_at > now() - interval '30 days'
          AND NOT (e.entity_type = 'integration' AND e.action = 'created')
          AND NOT (e.entity_type = 'notification_preferences' AND e.action = 'created')
      )
    )
  )
) AS recipients;
```

## Who (addresses are personal data: do not paste them into comments)

Run the inner query on its own.

## Same query in code

`selectEmailRecipients(db, now)` runs the same text, so the scheduler and this check cannot drift.
The real-Postgres test `briefing-email-scheduler.test.ts` checks that both return the same people.
