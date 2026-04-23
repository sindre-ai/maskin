# Sales — Starter Prompt

Paste the prompt below into Claude Code, Claude Desktop, Cowork, or Claude Web — any client with the Maskin MCP server connected. In under two minutes you'll have an outbound-sales workspace with a CRM, a deal pipeline, specialist agents, and daily pipeline review wired up.

## What you get

- **Object types:** `company`, `contact`, `deal` (plus `bet`, `task`, `insight` for strategy work)
- **Full pipeline statuses** — companies (`prospect → qualifying → qualified → customer → churned`), contacts (`identified → engaged → responsive → champion → inactive`), deals (`prospecting → discovery → proposal → negotiation → closed_won/closed_lost`)
- **Custom fields:** firmographics on companies (industry, size, website), email/title/linkedin on contacts, `value` / `close_date` / `stage_entered_at` / `loss_reason` on deals
- **Relationships:** `informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates`, `belongs_to`
- **Seed agents:** Lead Researcher, Outreach Drafter, Pipeline Analyst, Deal Coach
- **Triggers** that kick each agent on the right state change, plus a daily pipeline review cron
- **A starter graph:** one example company (`Acme Corp`), one example deal linked to it, and one example insight — enough that the pipeline is immediately walkable

## Copy this prompt

```
Set up a Maskin Outbound Sales workspace for me.

Call the `get_started` MCP tool with:
  template: "outbound-sales"
  apply:    true

That single call provisions:

- Object types `company`, `contact`, `deal` (plus `bet`, `task`, `insight` for strategy) with the full pipeline statuses
- Custom fields: `industry`, `size`, `website`, `notes` on companies; `email`, `title`, `linkedin` on contacts; `value`, `close_date`, `stage_entered_at`, `loss_reason` on deals
- Relationship types `informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates`, `belongs_to` (contacts belong to companies; deals relate to companies)
- Four specialist agents:
    • Lead Researcher — enriches companies moved to `qualifying` with industry intel, tech stack, and key contacts
    • Outreach Drafter — writes personalised messages when a contact moves to `engaged`
    • Deal Coach — prepares talking points, objection handling, and competitive positioning when a deal hits `negotiation`
    • Pipeline Analyst — runs a daily review of every deal and flags anything stale
- Event triggers: company.status_changed to qualifying → Researcher; contact.status_changed to engaged → Drafter; deal.status_changed to negotiation → Coach
- A daily cron trigger that runs the Pipeline Analyst and posts a summary
- A seed graph: one example company `Acme Corp` with a prospecting deal `Acme Corp - Platform License` related to it, plus one example insight informing the deal

If `get_started` is unavailable, fall back to composing the setup with `create_workspace` + `update_workspace` (for statuses, field definitions, and the CRM + pipeline custom extensions), `create_actor` for each agent (with a system prompt describing its role), `create_trigger` for each automation including the daily cron, and `create_objects` + relationships for the seed graph.

Once the template is applied:
1. Print the workspace URL.
2. Summarise what was created in one short paragraph.
3. Suggest three next actions — for example: (a) replace Acme Corp with a real target account, (b) move a contact to `engaged` to see the Outreach Drafter propose a message, (c) connect Gmail or a CRM integration so the agents can actually send and sync.
```

## Next steps

- Replace `Acme Corp` with a real target account and move it to `qualifying` — the Lead Researcher will enrich it
- Connect Gmail, HubSpot, or Salesforce from **Settings → Integrations** so outreach and syncs are real, not simulated
- Move a deal to `negotiation` to see the Deal Coach prepare talking points
- Check the morning digest from the Pipeline Analyst for the list of deals that need attention today
