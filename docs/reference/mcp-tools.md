---
title: MCP tools
slug: mcp-tools
description: The MCP tool surface — which tools exist, what they return, and when to reach for each.
last_updated: 2026-07-09
---

# MCP tools

Stub — content pending. See parent bet.

## Deprecated tool names

A tool that was removed from the surface can stay callable as a listed alias: a real entry in the tool list whose one line description says "Deprecated, use X", and whose handler maps its arguments onto the tool it points to. Listed, not hidden, because a model can only call tools it sees. Each one costs roughly 60 to 100 tokens in every tool list, so at most 10 are kept (see **packages/mcp/src/tool-aliases.ts**).

Today there is one: **run_agent**, an alias of **create_session** with **wait** on.

- **actor_id**, **action_prompt** and **spawned_by_message_id** carry over unchanged. **workspace_id** is filled from the connection default when it is missing.
- **notify_on_complete** is accepted and ignored: **create_session** no longer takes it and registers the same fallback itself when the wait times out.
- **config**, **poll_interval_seconds**, **timeout_seconds** and **depends_on_session_ids** have no equivalent and are dropped. Their names are recorded in the **alias_use** event.

Removal is a decision with a sweep date, never a zero count alone. Earliest for **run_agent**: late January 2027.

## Old-name telemetry (alias_use)

Every call that used an old tool name or an old argument key records one **alias_use** row in **mcp_telemetry** and one **mcp_alias_use** event in PostHog. It is its own event type, not a misfire kind: an alias hit is a success, and the misfire count must not move for it. Key names only, never values. The actor on the row is the owner of the API key that made the call, taken from the authenticated request.

Postgres is the source of truth (PostHog ingestion has been dark since 4 Oct). Known limits: the sink is fire and forget, so a dropped request can hide one use (the **tool_call** count in the same window bounds this but cannot prove zero); an external client appears only as an actor.

Removal check, run by hand or by a loop before any removal date is announced. An old name is safe to remove only when all three hold, reading **mcp_telemetry** by workspace and **created_at**, across every workspace the product serves:

1. No **alias_use** row for the old name in the last 30 days.
2. **tool_call** rows exist in the same window (so silence means no use, not no data).
3. A recorded test call using that old name landed in the 30 days before the clock started.

As SQL, for a tool-name alias (swap the last filter for a **data -> renames** containment test when the old name is an argument key). **:old_name** is the old tool name and **:clock_start** is the **created_at** of the production test call that started the clock, which must itself be at least 30 days old:

```sql
SELECT
  count(*) FILTER (WHERE event_type = 'alias_use' AND tool_name = :old_name
                   AND created_at > :clock_start)                         AS alias_uses_since_clock,
  count(*) FILTER (WHERE event_type = 'tool_call'
                   AND created_at > :clock_start)                         AS tool_calls_since_clock,
  count(*) FILTER (WHERE event_type = 'alias_use' AND tool_name = :old_name
                   AND created_at = :clock_start)                         AS test_call_rows
FROM mcp_telemetry;
```

Safe to remove when **alias_uses_since_clock** is 0, **tool_calls_since_clock** is above 0 and **test_call_rows** is 1. No workspace filter: read every workspace.

## Tool description length

No registered tool description is over 1,500 characters; **packages/mcp/src/__tests__/description-length.test.ts** fails if one is. The first sentence of each description says what the tool does and when to use it, because tool search matches on it. Keep the rules that stop a wrong call in the description; put walkthroughs here or on the parameter descriptions.

**get_actor** is the one exception until the 6 Nov 2026 misfire read (it is on the test's exemption list); shorten it after that read.

### create_actor: first steps and integrations

- Pass **first_steps** with 2 to 3 steps specific to the job the agent was made for, written as things the person can say to the agent.
- Use action **send** only for a step that reads and reports (a tap sends it as written, so **prompt** must equal **label**). Use **fill** for everything else: a step that needs words only the person can supply, or that writes, sends, spends or deletes.
- Pass **needed_integrations** for the tools the agent cannot do the job without.
- A new agent is always a member (never admin or owner). Setting **tools** or **llm_config** needs a human admin or owner caller; a member or agent caller gets a 403 and nothing is created.

### gmail_send_email: the two approval routes

1. Preferred: save the email as an object (**metadata.kind** email, **to**, **subject**, optional **cc**, text as **content**), mention the person with create_comment, and call the tool with only **object_id** once they approve. Any edit withdraws the approval. See [drafts.md](./drafts.md).
2. Older: a comment with a **decision** whose **draft** holds the email (real address in **to**, first line "Subject: ...", then the body), with exactly one destructive send option. After the person picks it, call the tool with only **approval_comment_id**. For several emails on one card use **decision.drafts** and pass each message's **draft_id**.

Never pass **to**, **subject** or **body**. If the answer says the outcome is unknown, do not send again; check the Sent folder.

### create_loop: steps, status and closing

A step and a trigger are the same thing: **steps** authors new triggers inline, **trigger_ids** attaches existing ones, and both land in the loop's step list. The response nests each step's resolved agent under it. Pick agents by role and system prompt (list_actors, list_triggers); create a specialised agent rather than reuse a mismatched one. **driver_id** is required: the agent accountable for the loop, one whose job covers the outcome, preferably the owner of the main target. A human, an unknown actor or a paused agent is refused before anything is created; update_loop can change it but never clear it. **status** runs draft, pilot, supervised, live and can be paused from any point (pausing disables every referenced trigger); **archived** is terminal. A loop is closed when one step is a feedback step. See [loops.md](./loops.md).

### request_keychain_credential: where the secret lands

The user types the value into the card and it goes to the encrypted vault; the agent never sees a login. An API key reaches the restarted agent as **KEYCHAIN_BYO_APIKEY_NAME** (name in capitals, other characters as underscores). A login is typed on the agent's computer with desktop_type using **{{keychain:Name.username}}** and **{{keychain:Name.password}}**.
