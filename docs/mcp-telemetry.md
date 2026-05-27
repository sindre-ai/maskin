# MCP telemetry — how to compute the bet's success metrics

The bet *Redesign Maskin MCP tool results for a simple, elegant Claude experience*
(`09ea5321-e003-46d4-aefa-8657b4c0d341`) measures two numbers over the dogfood
week:

- **Primary:** `% of MCP sessions with ≥1 deep-link click`, target ≥30%.
- **Secondary:** `average tokens per tool_call response`, target ≥60% reduction
  vs. baseline.

Both fall out of `mcp_telemetry`, which now stores three kinds of rows:

| event_type        | written by                                          |
| ----------------- | --------------------------------------------------- |
| `tool_call`       | `packages/mcp/src/server.ts` after every tool run   |
| `mutation`        | `packages/mcp/src/server.ts` after successful write |
| `deep_link_click` | `apps/dev/src/routes/deep-link.ts` on every `/r/…`  |

`session_id` is the same per-process correlation id on `tool_call` /
`mutation` and the `?s=…` query param on `deep_link_click`. The MCP server
attaches it to every deep link it renders, so a session's clicks land on the
same `session_id` its tool calls did.

## One-shot endpoint

Hit the workspace dashboard summary — it computes both metrics in one query:

```bash
curl -s -H "Authorization: Bearer $API_KEY" \
        -H "X-Workspace-Id: $WORKSPACE_ID" \
        "$API_BASE_URL/api/telemetry/mcp/summary?days=7" | jq
```

Look at:

- `click_session_pct` — primary metric. Target met when ≥ 30.
- `avg_content_tokens` — secondary metric. Compare against the pre-bet
  baseline noted in the bet's success criteria.
- `tool_call_size_samples` — count of `tool_call` rows that included a size
  measurement. If this is much lower than `tool_calls_total`, an older client
  is still emitting un-sized events; the average is over the sized subset.

## Raw SQL (psql / pgcli)

If you need to slice differently, the two metrics map to these queries.

### Primary — click-through sessions

```sql
WITH sessions AS (
  SELECT session_id,
         bool_or(event_type = 'deep_link_click') AS has_click
    FROM mcp_telemetry
   WHERE workspace_id = :ws
     AND created_at >= now() - interval '7 days'
     AND session_id IS NOT NULL
   GROUP BY session_id
  HAVING bool_or(event_type = 'tool_call')
)
SELECT count(*)                              AS sessions_total,
       count(*) FILTER (WHERE has_click)     AS sessions_with_click,
       100.0 * count(*) FILTER (WHERE has_click) / nullif(count(*), 0)
                                             AS click_session_pct
  FROM sessions;
```

A session counts when it produced at least one `tool_call`. A session with
only a stale click and no tool call doesn't inflate the numerator.

### Secondary — tokens per tool result

```sql
SELECT count(content_bytes)                  AS samples,
       avg(content_bytes)::int               AS avg_content_bytes,
       avg(content_tokens)::int              AS avg_content_tokens,
       avg(structured_content_bytes)::int    AS avg_structured_content_bytes
  FROM mcp_telemetry
 WHERE workspace_id = :ws
   AND event_type = 'tool_call'
   AND created_at >= now() - interval '7 days'
   AND content_bytes IS NOT NULL;
```

`content_tokens` is `ceil(content_bytes / 4)` — Anthropic's rule-of-thumb for
English/code. Good for trend comparison, not exact billing. The filter on
`content_bytes IS NOT NULL` ignores `mutation` / `deep_link_click` rows and
older `tool_call` rows that don't include size measurements.

### Click breakdown by surface

For the verdict comment, it helps to know *which* deep links people clicked.
`data->>'kind'` is set by Task 1's redirect to `object | list | search |
activity | actor | trigger | settings | workspace | unknown`.

```sql
SELECT data->>'kind' AS kind,
       count(*)      AS clicks
  FROM mcp_telemetry
 WHERE workspace_id = :ws
   AND event_type = 'deep_link_click'
   AND created_at >= now() - interval '7 days'
 GROUP BY 1
 ORDER BY 2 DESC;
```
