---
title: MCP tools
slug: mcp-tools
description: The MCP tool surface — which tools exist, what they return, and when to reach for each.
last_updated: 2026-11-11
---

# MCP tools

Stub — content pending. See parent bet.

## Files

### Reading a file: `get_file`

`get_file` returns the stored bytes as `content` by default (`format: "raw"`). Any
HTML page an agent writes (a deck, a website, a dashboard, a custom view) can be
mostly embedded base64 fonts and inline CSS or script, so its raw `content` is
hundreds of kilobytes of noise. Pass `format: "text"` to read the words instead:

- `content_text` is markdown: headings, paragraphs, bullets, tables, links and code,
  plus the labels of buttons, fields and menus (`[button: Save]`,
  `[input text: Search]`, `[select Status: Open, Done]`). A deck
  (`<section class="slide">`) gets one block per slide (`Slide N`) and its speaker
  notes held in `data-notes`; a deck's own buttons are navigation chrome and are
  left out. Styles, scripts, SVG and `data:` URIs are left out. If the page carries a
  `<script type="text/markdown" id="deck-source">`, that source is returned as is.
- `note` appears when the page shows almost no text in its markup but carries
  script, which means a person sees what the script draws. The extract is then not
  what they see: read the raw file for the logic and data.
- Also returned: `title`, `meta_description`, `json_ld` (when present),
  `source_object_id` (when a `derived_from` or `relates_to` edge ties the file to an
  object), `contentHash`, `annotations`, `url` and `extracted: true`.
- A text file that is not HTML comes back unchanged with `extracted: false`. A
  binary file ignores `format` and returns the usual response.
- The text is computed on every read from the stored bytes. Nothing is stored, so
  it can never be stale. HTML over 8 MB is refused with a 400; read it raw.

A raw read of an HTML file over 100 KB that is mostly embedded data opens with a
`readable_with` field (for example `get_file format=text (96% of this file is
embedded fonts)`), placed before `content` so a reader that stops early still sees it.

There is no `offset` or `limit` on `get_file`. Use `format: "text"` rather than
paging raw bytes.

### Changing part of a file: `update_file` with `edits`

`update_file` takes either `content` (replace the whole file) or `edits` (change
parts of a text file), never both. `edits` is a list of `{ old, new, replace_all? }`
applied in order on the server, under the same row lock as a whole-file save:

- `old` must appear exactly once in the text as it stands after the earlier edits,
  unless `replace_all` is true. No match, or more than one match without
  `replace_all`, fails with a 400 that names the edit, and nothing is written.
- `new` is literal text; it may be empty to delete.
- Text MIME types only (not base64, not images or video). Files over 50 MB cannot
  be edited. The result must stay under the file type's size cap.
- At most 50 edits, 200,000 characters per `old` or `new`, 1,000,000 characters in
  total.
- `if_match` works as for `content`: a stale hash fails with 409 and writes nothing.
- `old` must match the stored bytes, so copy it from a raw `get_file` read, not from
  the `format: "text"` extract (which drops markup).
- The save logs an `updated` event for the file, with `editCount`.

### Transcribing a recording: `transcribe_file`

`transcribe_file` turns an uploaded audio or video file into text. The agent passes the
file `id` and, optionally, a `language` hint; it never downloads or converts anything.

- Returns `{ file_id, name, text, text_truncated, transcript_file_id, transcript_file_url,
  audio_seconds, chunks, model }`. The transcript is plain (no timestamps, no speaker labels)
  and is **always** saved as a `text/plain` workspace file, named `<recording> transcript.txt`
  and tagged `transcript`, whatever its length: there is no size threshold. `text` is only the
  first 1000 characters (`text_truncated` says whether there is more); the whole transcript is
  `get_file` on `transcript_file_id`. `text` is empty when no speech was found.
- Saving goes through `saveTranscriptFile` (`apps/dev/src/services/transcript-file.ts`), in
  the same order as `POST /api/files`: row, bytes, `created` event. If it fails, the audio is
  already paid for, so the call still succeeds with the whole text in `text`, `text_truncated`
  false and `transcript_file_id` null.
- Audio and video both work. The server decodes the first audio track to 16 kHz mono WAV with
  ffmpeg, so the API image must have ffmpeg and ffprobe (`apps/dev/Dockerfile`); a local
  `pnpm dev` needs them on `PATH`. Without them the call fails with a 503 that says so.
- Up to 60 minutes of audio per call. The audio is cut into 3 minute chunks (the speech
  provider times out after about a minute per request), three are sent at a time, and the
  texts are joined in order. A longer file is a 400 that asks for it to be cut up.
- The file is streamed from storage to a temp directory, never held in memory, so the 1 GiB
  upload ceiling applies. Only `audio/*`, `video/*` and a few container types are tried; any
  other MIME type is a 400 before anything is downloaded.
- Route: `POST /api/transcriptions/files/:id`, writer role, file must be in the
  `X-Workspace-Id` workspace (another workspace's file is a 404). It sits under
  `ALL /api/transcriptions` in `packages/auth/src/oauth-route-allowlist.ts`, so a Claude
  connector token is refused (403 `insufficient_scope`); agents and API keys are fine.

**Billing.** The call runs on Maskin's OpenRouter account, so it is charged to the workspace's
plan. OpenRouter reports `usage.cost` for each request; that figure, not an estimate, is
written to `workspace_ai_usage` (one row per call, with the model, the audio seconds, the
actor and the file). Plan usage is `sessions` cost plus these rows, in one place:
`getWorkspacePlanUsdCentsUsage` in `apps/dev/src/lib/llm-routing.ts`. That makes the plan cap,
the usage page (and its model, agent and flow split) and the prepaid credit overage all see it.

- Before any work, `checkPlanCap` runs: over the cap with no credit balance is a 402
  `PLAN_CAP_EXCEEDED`, the same as starting a session.
- An enterprise workspace is exempt from the plan cap (`checkPlanCap` returns early), so it is
  never refused with a 402. Its spend is still recorded in `workspace_ai_usage`.
- Spend of chunks that succeeded is recorded even if a later chunk fails: it was charged.
- Credit overage is settled the next time a session ends (the debit takes the period's whole
  overage minus what was already accounted), not at the moment of transcription.
- If OpenRouter omits `usage.cost`, the call is counted at `FALLBACK_USD_PER_AUDIO_SECOND`
  (above the dearest listed model) and a warning is logged.
- Chat dictation (`POST /api/transcriptions`) is unchanged and still not counted.

## Workspace skills: id or name

`get_workspace_skill`, `update_workspace_skill` and `delete_workspace_skill` take the skill in their `name` argument, and that value can be either the skill's id (as listed by `list_workspace_skills`) or its name. The argument key stays `name`.

- A lowercase UUID-shaped value is tried as an id first. If no skill in the workspace has that id, it is tried as a name, so a skill that happens to be named like a UUID is still reachable.
- Any other value is tried as an exact name. There is no trimming, fuzzy matching or case-insensitive matching.
- Both lookups are scoped to the workspace in the call, so an id from another workspace is "not found".
- An unknown value returns 404 NOT_FOUND: `No skill with id or name '<value>' in this workspace. Call list_workspace_skills for valid ids and names.`
- Updates and deletes by name write to the resolved row's id, so they touch exactly one skill.

The lookup lives in the API route (`apps/dev/src/routes/workspace-skills.ts`) on top of `resolveByIdOrName` (`apps/dev/src/lib/resolve-by-id-or-name.ts`), so the web app and direct API callers get the same rule. `attach_skill_ids` and `detach_skill_ids` stay id-only.

## list_objects: list and search in one call

**list_objects** is the one tool for listing and searching objects. It takes everything it took before, plus these parameters (wave 2 of the list contract):

- **q**: search text, matched against title and content. When set, the walk is ranked by match quality and **sort** defaults to **relevance**. Ranked walks page with the same **cursor** as plain ones.
- **status**: one status, or a list meaning "any of these", for example ["todo", "in_progress"].
- **sort**: **created_at_desc** (default without **q**), **created_at_asc**, **updated_at_desc**, **updated_at_asc**, or **relevance** (default with **q**; an error without **q**). With **q** the ranking decides the order and the column only fixes what the walk's snapshot freezes.
- **detail**: **full** (default, today's rows exactly) or **concise** (id, type, title, status, driver, updatedAt and url, no content).
- **updated_before**: now also works together with **q**.
- **workspace_id**: optional. Left out, the call runs in the caller's default workspace.

Unchanged: **type**, **driver**, **updated_after**, **limit** (default 25, max 100), **cursor**, **metadata_eq** and **include_archived**. The page block carries **limit**, **returned**, **has_more** and **total**; **total** is null when **q** is set, because the search route sends no count. Keep the same filters and **q** while following **next_cursor**.

**search_objects** is now a listed alias of **list_objects** (see below). New calls should use **list_objects** with **q**.

## Deprecated tool names

A tool that was removed from the surface can stay callable as a listed alias: a real entry in the tool list whose one line description says "Deprecated, use X", and whose handler maps its arguments onto the tool it points to. Listed, not hidden, because a model can only call tools it sees. Each one costs roughly 60 to 100 tokens in every tool list, so at most 10 are kept (see **packages/mcp/src/tool-aliases.ts**).

Today there are two:

- **run_agent**, an alias of **create_session** with **wait** on (details below).
- **search_objects**, an alias of **list_objects**. It maps **query** to **q**, **driver_id** to **driver** and **offset** to the ranked walk's offset, and passes everything else through, **cursor** included, so a caller can follow **next_cursor** or **page.offset**. Its output is the **list_objects** output, with **page.offset** kept for older callers. Reason: one query tool with one paging style, so agents stop retrying across two tools. Earliest removal: 2027-02-01, and only after a clean stored-prompt sweep (see the ledger entry in **packages/mcp/src/removal-ledger.ts**).

For **run_agent**:

- **actor_id**, **action_prompt** and **spawned_by_message_id** carry over unchanged. **workspace_id** is filled from the connection default when it is missing.
- **notify_on_complete** is accepted and ignored: **create_session** no longer takes it and registers the same fallback itself when the wait times out.
- **config**, **poll_interval_seconds**, **timeout_seconds** and **depends_on_session_ids** have no equivalent and are dropped. Their names are recorded in the **alias_use** event.

Removal is a decision with a sweep date, never a zero count alone. Earliest for **run_agent**: late January 2027.

### Rollback for the list contract

**MASKIN_MCP_LIST_CONTRACT** is an environment variable read when the server starts. Setting it to **off** (also **0**, **false**, **no**, **disabled**) brings back the old **list_objects** and **search_objects**, tool list included. Infra & DevOps changes it and restarts the server; it is not an instant flip. It is set in Coolify on the application "Zero-Downtime Maskin" (the API process serves **/mcp**), as a runtime-only variable, then the application is restarted. Allow up to 10 minutes from the request to the old tools being live: the last 50 production deploys of that application took 81 seconds at the shortest, 263 at the median and 490 at the slowest, and a restart does not rebuild the image. To undo the rollback, delete the variable and restart again.

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

### delete_agent: a person approves first

An agent may delete another agent only after a person says yes on a decision card.

1. The agent posts **create_comment** on a relevant object with a **decision**, mentions the person, and puts **delete_agent: { actor_id }** on the destructive option that approves it. The API refuses a card that names itself, a person, a system agent, an agent of another workspace, or more than one agent.
2. The person taps that option. Their reply records a **deletion_approved** event on the agent, naming the asking agent. Nothing is deleted by the tap. Replies from an agent, or sent through MCP, never approve.
3. The reply wakes the asking agent, which calls **delete_agent** with the same **id**. **DELETE /api/actors/:id** from an agent is allowed only while an approval from the last 24 hours names that agent as the asker and that target. Otherwise it is a 403 that says how to ask. An agent cannot delete itself.

A person deleting an agent from the app is unchanged and needs no approval.

### gmail_send_email: the two approval routes

1. Preferred: save the email as an object (**metadata.kind** email, **to**, **subject**, optional **cc**, text as **content**), mention the person with create_comment, and call the tool with only **object_id** once they approve. Any edit withdraws the approval. See [drafts.md](./drafts.md).
2. Older: a comment with a **decision** whose **draft** holds the email (real address in **to**, first line "Subject: ...", then the body), with exactly one destructive send option. After the person picks it, call the tool with only **approval_comment_id**. For several emails on one card use **decision.drafts** and pass each message's **draft_id**.

Never pass **to**, **subject** or **body**. If the answer says the outcome is unknown, do not send again; check the Sent folder.

### create_loop: steps, status and closing

A step and a trigger are the same thing: **steps** authors new triggers inline, **trigger_ids** attaches existing ones, and both land in the loop's step list. The response nests each step's resolved agent under it. Pick agents by role and system prompt (list_actors, list_triggers); create a specialised agent rather than reuse a mismatched one. **driver_id** is required: the agent accountable for the loop, one whose job covers the outcome, preferably the owner of the main target. A human, an unknown actor or a paused agent is refused before anything is created; update_loop can change it but never clear it. **status** runs draft, pilot, supervised, live and can be paused from any point (pausing disables every referenced trigger); **archived** is terminal. A loop is closed when one step is a feedback step. See [loops.md](./loops.md).

### request_keychain_credential: where the secret lands

The user types the value into the card and it goes to the encrypted vault; the agent never sees a login. An API key reaches the restarted agent as **KEYCHAIN_BYO_APIKEY_NAME** (name in capitals, other characters as underscores). A login is typed on the agent's computer with desktop_type using **{{keychain:Name.username}}** and **{{keychain:Name.password}}**.
