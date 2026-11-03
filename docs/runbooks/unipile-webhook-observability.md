# Unipile webhook observability: runbook

Bet: Unipile webhook events as triggers. Task: Observability / saved queries.

Every Unipile webhook delivery leaves three traces:

1. One structured log line, message "linkedin-unipile webhook: delivery", with event_type, integration_id, account_id, external_id, envelope_id, outcome (emitted, duplicate, dropped, failed), reason, classification, direction_source and latency_ms (ingest time minus provider_timestamp). Ids and codes only, never message text or names. Failed deliveries also carry an error message and log at error level.
2. One PostHog event, unipile_webhook_received, with event_type, mapped, deduped, outcome, reason, workspace_id and account_id. It fires only when an integration row was resolved (no workspace otherwise, so unknown event types and accounts with no active integration are log-only). The reason property is an addition to the property list in the tech spec, needed so drop reasons can be counted (see query e).
3. An events row (entityType linkedin.message) for every delivery that was emitted, a dead-letter events row (entityType linkedin.webhook, action failed) for every failure after the claim, and a dropped events row (entityType linkedin.webhook, action dropped) for each direction_unknown or direction_conflict drop.

Wake latency, duplicates, webhook misses and direction drops are read from the database, not PostHog, because PostHog has no webhook events before this task. The queries below are plain SQL against the app database. Change the 7 days window where needed. Each query was run once against a real Postgres seeded with fixture events (see the PR for the output).

## a. Wake latency

One row per webhook message event that woke a session: ingest lag (provider timestamp to our events row), wake latency (events row to session start) and the session. The session is the first one the trigger started at or after its trigger_fired row. A duplicate wake (two trigger_fired rows for one message, see b1) shows up here as an extra row for the same message.

    -- query: a
    SELECT m.workspace_id,
           m.id AS message_event_id,
           m.data->>'message_id' AS message_id,
           tf.entity_id AS trigger_id,
           s.id AS session_id,
           round(EXTRACT(EPOCH FROM (m.created_at - (m.data->>'provider_timestamp')::timestamptz))::numeric, 1) AS ingest_lag_s,
           round(EXTRACT(EPOCH FROM (s.started_at - m.created_at))::numeric, 1) AS wake_latency_s
    FROM events m
    JOIN events tf
      ON tf.workspace_id = m.workspace_id
     AND tf.action = 'trigger_fired'
     AND tf.entity_type = 'trigger'
     AND tf.data->'source_event'->>'event_id' = m.id::text
    JOIN LATERAL (
      SELECT id, started_at
      FROM sessions
      WHERE trigger_id = tf.entity_id
        AND created_at >= tf.created_at - interval '5 seconds'
      ORDER BY created_at
      LIMIT 1
    ) s ON true
    WHERE m.entity_type = 'linkedin.message'
      AND m.created_at > now() - interval '7 days'
    ORDER BY m.created_at;

Summary of the same rows (p50, p95 and max wake latency):

    -- query: a-summary
    SELECT count(*) AS wakes,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY wake_latency_s) AS p50_s,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY wake_latency_s) AS p95_s,
           max(wake_latency_s) AS max_s
    FROM (
      SELECT EXTRACT(EPOCH FROM (s.started_at - m.created_at)) AS wake_latency_s
      FROM events m
      JOIN events tf
        ON tf.workspace_id = m.workspace_id
       AND tf.action = 'trigger_fired'
       AND tf.entity_type = 'trigger'
       AND tf.data->'source_event'->>'event_id' = m.id::text
      JOIN LATERAL (
        SELECT started_at FROM sessions
        WHERE trigger_id = tf.entity_id AND created_at >= tf.created_at - interval '5 seconds'
        ORDER BY created_at LIMIT 1
      ) s ON true
      WHERE m.entity_type = 'linkedin.message'
        AND m.created_at > now() - interval '7 days'
    ) w;

## b. Duplicate wakes

b1: trigger_fired rows that share one source event id and one trigger id. Any row returned is a duplicate wake. Target: zero rows.

    -- query: b1
    SELECT tf.workspace_id,
           tf.entity_id AS trigger_id,
           tf.data->'source_event'->>'event_id' AS source_event_id,
           count(*) AS fired
    FROM events tf
    WHERE tf.action = 'trigger_fired'
      AND tf.entity_type = 'trigger'
      AND tf.data->'source_event'->>'entity_type' = 'linkedin.message'
      AND tf.created_at > now() - interval '7 days'
    GROUP BY 1, 2, 3
    HAVING count(*) > 1;

b2: more than one session whose prompt carries the same message id. The trigger prompt embeds the triggering event, so the message id appears in the session's action_prompt. Target: zero rows.

    -- query: b2
    SELECT m.workspace_id,
           m.data->>'message_id' AS message_id,
           count(DISTINCT s.id) AS sessions,
           array_agg(DISTINCT s.id) AS session_ids
    FROM events m
    JOIN sessions s
      ON s.workspace_id = m.workspace_id
     AND s.created_at >= m.created_at
     AND strpos(s.action_prompt, m.data->>'message_id') > 0
    WHERE m.entity_type = 'linkedin.message'
      AND m.created_at > now() - interval '7 days'
    GROUP BY 1, 2
    HAVING count(DISTINCT s.id) > 1;

## c. Webhook misses

Replies an agent answered that never arrived by webhook. The answered side is the claim-before-send ledger (idempotency_records), key linkedin-unipile:ACTOR_ID:POST:/api/integrations/linkedin-unipile/send-message:inbound:CHAT_ID:MESSAGE_ID, status 200 once the send finished. The reply tool builds that key on the server from the chat and the inbound message being answered, so the webhook path and the sweep path write the same key. Each answered key with no linkedin.message event carrying that message id is a webhook miss, whoever answered it. Target: zero rows. There is no percentage and no snapshot table.

Valid only after the double-send guard task has merged. The key format and the 24 hour expiry (LINKEDIN_TOOL_CALLS_TTL_MS in operations.ts) were read on that task's branch (feat/task-01d040b1-double-send-guard, commit e3f31d9fd), not on this PR's base: the bet branch has no inbound: key yet, so until that task lands this returns nothing, and an empty result means nothing. Re-check the key format and the expiry in operations.ts once it has merged.

The ledger is purged after 24 hours, so the Product Validator runs this daily inside that window and records the day's row count in this runbook. The full comparison of what the sweep found against what the webhook delivered happens once, in the shadow week, against the Unipile list-messages API. It is not a standing query.

    -- query: c
    WITH answered AS (
      SELECT m[1] AS chat_id,
             m[2] AS message_id,
             r.created_at AS answered_at
      FROM idempotency_records r
      CROSS JOIN LATERAL regexp_match(r.key, ':inbound:([^:]+):(.+)$') AS m
      WHERE r.key LIKE 'linkedin-unipile:%:inbound:%'
        AND r.status = 200
        AND r.created_at > now() - interval '24 hours'
    )
    SELECT a.chat_id, a.message_id, a.answered_at
    FROM answered a
    WHERE NOT EXISTS (
      SELECT 1 FROM events m
      WHERE m.entity_type = 'linkedin.message'
        AND m.data->>'message_id' = a.message_id
    )
    ORDER BY a.answered_at;

Daily counts (Product Validator fills in, one line per day): date, rows returned.

## d. Chat-level repeat wakes

The same chat producing 2 or more wakes within 5 minutes. This decides whether to build batching per chat (option B in the tech spec), so it is logged from day one. Each row is a chat and the first wake of a window with the number of wakes in the following 5 minutes. Duplicate trigger_fired rows (b1) count as repeat wakes here, so read this alongside b1.

    -- query: d
    WITH wakes AS (
      SELECT m.workspace_id,
             m.data->>'chat_id' AS chat_id,
             tf.created_at AS fired_at
      FROM events m
      JOIN events tf
        ON tf.workspace_id = m.workspace_id
       AND tf.action = 'trigger_fired'
       AND tf.entity_type = 'trigger'
       AND tf.data->'source_event'->>'event_id' = m.id::text
      WHERE m.entity_type = 'linkedin.message'
        AND m.created_at > now() - interval '7 days'
    )
    SELECT w1.workspace_id,
           w1.chat_id,
           w1.fired_at AS window_start,
           count(w2.*) + 1 AS wakes_in_window
    FROM wakes w1
    JOIN wakes w2
      ON w2.workspace_id = w1.workspace_id
     AND w2.chat_id = w1.chat_id
     AND w2.fired_at > w1.fired_at
     AND w2.fired_at <= w1.fired_at + interval '5 minutes'
    GROUP BY 1, 2, 3
    ORDER BY w1.fired_at;

## e. Direction drops (direction_unknown, direction_conflict)

Both drops write one events row (entityType linkedin.webhook, action dropped, entity id the integration id), with the reason, event_type, external_id, envelope_id and account_id in data. Ids only, no message text. own_message, flag_off and no_active_integration are expected and frequent, so they write no row. The write is guarded like the dead-letter write: if it fails the delivery's answer, claims and dedupe are unchanged and an error line "failed to write direction drop event" is logged. A retry can write a second row for the same delivery, so the count is of distinct envelope_id. Expected volume is zero.

    -- query: e
    SELECT date_trunc('day', created_at) AS day,
           workspace_id,
           data->>'reason' AS reason,
           count(DISTINCT data->>'envelope_id') AS drops
    FROM events
    WHERE entity_type = 'linkedin.webhook'
      AND action = 'dropped'
      AND created_at > now() - interval '7 days'
    GROUP BY 1, 2, 3
    ORDER BY 1 DESC;

The reason is also on every unipile_webhook_received PostHog event and on the log line. PostHog is a secondary view only. The test suite asserts the capture call carries the reason, but nothing in CI or in the build session can assert the event lands in PostHog (no PostHog access, and sampling or dropping on the PostHog side is not visible from here). Treat any PostHog-only version of this alert as blind to a PostHog-side loss. The alert reads this query.

## f. Dead-letter events

Failures after the claim. The claims are released and the delivery answers 503 so Unipile retries; the dead-letter row is the durable record.

    -- query: f
    SELECT date_trunc('day', created_at) AS day,
           workspace_id,
           data->>'error_code' AS error_code,
           count(*) AS dead_letters
    FROM events
    WHERE entity_type = 'linkedin.webhook'
      AND action = 'failed'
      AND created_at > now() - interval '7 days'
    GROUP BY 1, 2, 3
    ORDER BY 1 DESC;

## g. Session cost after the shadow week

sessions.total_cost_usd holds the per-session dollar cost. Baseline for the whole platform is about 6,600 sessions a week. This reads the cost of the sessions the webhook triggers started.

    -- query: g
    SELECT count(*) AS sessions,
           sum(s.total_cost_usd) AS total_cost_usd,
           round(avg(s.total_cost_usd), 4) AS avg_cost_usd
    FROM sessions s
    WHERE s.trigger_id IN (
      SELECT DISTINCT tf.entity_id
      FROM events tf
      WHERE tf.action = 'trigger_fired'
        AND tf.entity_type = 'trigger'
        AND tf.data->'source_event'->>'entity_type' = 'linkedin.message'
    )
      AND s.created_at > now() - interval '7 days';

## Alert conditions

Wiring these into Sentry or Grafana is not part of this task. The thresholds below are the contract for whoever does it.

1. Dead letters: query f returns any row for the current day (count above 0 in a day).
2. Secret drift: a spike of 401 responses on the webhook route. The route logs "linkedin-unipile webhook: signature verification failed" at warn on each one. Proposed threshold: more than 5 in any 10 minutes (a healthy deployment has none). The number is a proposal, not set by the spec.
3. Direction drops: any direction_unknown or direction_conflict count above 0 (query e). The tech spec treats any of these as a sign that is_sender is not reliable on real payloads.
