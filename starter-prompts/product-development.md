# Product Development — Starter Prompt

Paste the prompt below into Claude Code, Claude Desktop, Cowork, or Claude Web — any client with the Maskin MCP server connected. In under two minutes you'll have a working product-development workspace with insights, bets, tasks, seed agents, and triggers wired up.

## What you get

- **Object types:** `insight`, `bet`, `task`
- **Full lifecycle statuses** — bets move through `signal → proposed → active → completed/succeeded/failed/paused`; tasks move through `todo → in_progress → in_review → testing → done/blocked`; insights through `new → processing → clustered/discarded`
- **Custom fields:** `github_repo` on bets, `github_link` on tasks, `tags` on insights
- **Relationships:** `informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates`
- **Seed agents:** Insight Triager, Bet Evaluator, Task Executor
- **Triggers** that wake each agent on the right status change
- **A starter graph** (one active bet broken into two tasks, plus an example insight) so the workspace isn't empty on first visit

## Copy this prompt

```
Set up a Maskin Product Development workspace for me.

Call the `get_started` MCP tool with:
  template: "development"
  confirm:  true

That single call provisions:

- Object types `insight`, `bet`, `task` with the full lifecycle statuses
- Custom fields `github_repo` (bet), `github_link` (task), `tags` (insight)
- Relationship types `informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates`
- Three seed agents:
    • Insight Triager — clusters new insights into themes
    • Bet Evaluator — scores proposed bets on impact and effort
    • Task Executor — picks up tasks moved to `in_progress` and ships PRs
- Event triggers: insight.created → Triager; bet status_changed to proposed → Evaluator; task status_changed to in_progress → Executor
- A seed graph: one active bet "Ship the first end-to-end feature" broken into two todo tasks, with one example insight informing it

If `get_started` is unavailable for any reason, fall back to composing the setup yourself with `create_workspace` + `update_workspace` for the schema, `create_actor` for each agent (with a system prompt describing its role), `create_trigger` for each automation, and `create_objects` + relationships for the seed graph.

Once the template is applied:
1. Print the workspace URL.
2. Summarise what was created in one short paragraph.
3. Suggest three next actions — for example: (a) capture a real insight from recent user feedback, (b) set `github_repo` on the bet so the Task Executor can ship PRs, (c) move a task to `in_progress` and watch the Executor pick it up.
```

## Next steps

- Customise agent system prompts from **Settings → Agents**
- Point the first bet at a real GitHub repo by setting the `github_repo` field
- Move a task to `in_progress` to watch the Task Executor open a PR
- Drop new insights in as they arrive — the Triager clusters them into themes the Bet Evaluator can turn into proposals
