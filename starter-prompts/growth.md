# Growth — Starter Prompt

Paste the prompt below into Claude Code, Claude Desktop, Cowork, or Claude Web — any client with the Maskin MCP server connected. In under two minutes you'll have a growth workspace with a full agent org, a CRM, a LinkedIn content module, and tag-routed task triggers wired up.

## What you get

- **Object types:** `insight`, `bet`, `task`, `contact`, `company`, `linkedin_post`
- **Full pipeline statuses** on contacts (`new_lead → connection_requested → messaged → in_conversation → meeting_booked → converted`), companies (`prospect → icp_match → engaged → customer`), and LinkedIn posts (`draft → proposed → approved → published`)
- **Custom fields** tuned for outreach: `tag` on tasks (outreach / content / scouting / video / ops / launch), `priority`, `outreach_stage`, `response_status`, `icp_score` on contacts
- **Relationships:** `informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates`, `works_at`, `decision_maker_at`, `derived_from`
- **Seed agents:** Bet Decomposer, SDR, Content Agent, Scout, Growth Ops, Curator, Launch Manager
- **Tag-routed triggers** — each task picks up the right specialist based on its `tag`
- **Daily / weekly review triggers** that score progress and recommend next moves
- **A starter graph:** one active bet ("Reach our first 100 users") broken into three tagged tasks, an example company, contact, and insight

## Copy this prompt

```
Set up a Maskin Growth workspace for me.

Call the `get_started` MCP tool with:
  template: "growth"
  confirm:  true

That single call provisions:

- Object types `insight`, `bet`, `task`, `contact`, `company`, `linkedin_post` with their full pipeline statuses
- Custom fields: `tag`, `impact`, `effort`, `deadline` on bets/tasks; CRM fields (`linkedin_url`, `email`, `position`, `priority`, `outreach_stage`, `response_status`, `icp_score`, `icp_reasoning`) on contacts; firmographics on companies; hook/source fields on LinkedIn posts
- Relationship types `informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates`, `works_at`, `decision_maker_at`, `derived_from`
- A full agent org:
    • Bet Decomposer — breaks bets into tagged tasks
    • SDR — drafts personal outreach for `outreach` tasks
    • Content Agent — drafts posts for `content` tasks
    • Scout — finds reply opportunities for `scouting` tasks
    • Growth Ops — reviews work for `ops` tasks
    • Curator — classifies inbound signals
    • Launch Manager — coordinates launches for `launch` tasks
- Tag-routed event triggers: when a task moves to `in_progress`, the agent matching its `tag` picks it up
- Daily and weekly cron triggers for pipeline review and insight digest
- A seed graph: one active bet "Reach our first 100 users" broken into outreach / content / scouting tasks, one example company + contact wired with `works_at`, and one insight informing the bet

If `get_started` is unavailable, fall back to composing the setup with `create_workspace` + `update_workspace` (for statuses, field definitions, and the CRM + LinkedIn custom extensions), `create_actor` for each agent, `create_trigger` for each automation (tag-routed event triggers + daily/weekly crons), and `create_objects` + relationships for the seed graph.

Once the template is applied:
1. Print the workspace URL.
2. Summarise what was created in one short paragraph.
3. Suggest three next actions — for example: (a) replace the example contact/company with a real prospect, (b) move the outreach task to `in_progress` and let the SDR draft a message, (c) drop in a recent user signal as an insight and watch the Curator classify it.
```

## Next steps

- Replace the example `Example Co` / `Jane Doe` with a real target account
- Move the outreach task to `in_progress` to see the SDR draft a message
- Connect Slack, Gmail, or LinkedIn integrations from **Settings → Integrations** so agents can actually send
- Ask the Bet Decomposer for new bets whenever you set a fresh goal — it writes the task plan for you
