---
name: workspace-observer-onboarding
description: Guides the Workspace Coach to run onboarding for a new workspace — detecting an empty workspace, creating an onboarding session, subscribing the owner, and posting context prompts in sequence to get the workspace to its first bet.
---

# Workspace Coach Onboarding

## When to run

Run this skill when your observation detects a workspace that:
- Has `onboarding_enabled = true` (read from `list_workspaces` — exit silently if `false`)
- Was created within the last 24 hours (check `createdAt` on the workspace)
- Has zero bets (no objects of type `bet` exist in the workspace)

If an `onboarding_session` object already exists for this workspace, exit silently — onboarding is already underway.

## What to do

### 1. Create the onboarding session

Call `create_objects` to create a single object:
- `type: onboarding_session`
- `title: "Getting your workspace ready"`
- `status: active`
- `content`: brief description of what this session is — "A guided conversation to capture the context agents need to run quality bets. Takes 5–10 minutes."

Save the returned object ID — all prompts in the next step are comments posted on this object.

### 2. Subscribe the workspace owner

Call `subscribe` with the onboarding session object ID and the workspace owner's actor ID. This ensures the owner receives the prompts via their For You feed.

To find the workspace owner: list workspace members and identify the human actor (type != "agent") who created the workspace or is listed as owner. Keep the owner's actor ID and the workspace ID handy — every knowledge write in step 4 needs them.

### 3. Post prompts in sequence

Post the five prompts below as comments on the onboarding session object, in order. **Wait for a reply to each prompt before posting the next one.** Capture each reply as a knowledge object (see step 4).

The tone is conversational — you are an assistant asking questions, not a form. Write each prompt as a short message.

**Prompt 1 — Product vision** (`prompt_key: product_vision`)
> What does your product do and who is it for? A sentence or two is enough — just enough for agents to understand what you're building and what outcome you're going for.

**Prompt 2 — ICP** (`prompt_key: icp`)
> Who is your ideal customer? The sharper the better — role, company type, the specific pain they have. If you have real customers already, describe one of them.

**Prompt 3 — First-bet hypothesis** (`prompt_key: first_bet_hypothesis`)
> What's the single most important thing to figure out or build right now? This becomes your first bet — what would move the needle most if it worked?

**Prompt 4 — North Star metric** (`prompt_key: north_star_metric`)
> How will you know the product is working? Name one number — the metric that, if it goes up, you're succeeding.

**Prompt 5 — Customer evidence** (`prompt_key: customer_evidence`)
> What have you already heard from customers or potential customers? Even a single quote or observation is useful — agents use this to calibrate bet quality and avoid building the wrong thing.

### 4. Capture each reply as a knowledge object AND an `about` edge — one atomic call

After each reply, call `create_objects` **once** with both the knowledge node and the `about` edge in the same batch. The knowledge row and its edge must commit together — no bare-knowledge row about the workspace owner may survive.

The edge target depends on the prompt:

- `product_vision`, `icp`, `first_bet_hypothesis`, `customer_evidence` → **owner-targeted**: edge target = the workspace owner's actor id, `metadata.subject_kind = "workspace_owner"`.
- `north_star_metric` → **workspace-targeted**: edge target = the workspace id, `metadata.subject_kind = "workspace"`.

Payload shape (owner-targeted example):

```json
{
  "nodes": [
    {
      "$id": "k1",
      "type": "knowledge",
      "title": "Product vision",
      "status": "validated",
      "content": "<owner's reply verbatim, or a clean restatement if conversational>",
      "metadata": {
        "source": "workspace_onboarding",
        "prompt_key": "product_vision",
        "subject_kind": "workspace_owner",
        "subject_id": "<owner-actor-uuid>",
        "claim": "<one-sentence restatement of what the reply asserts>",
        "confidence": "medium",
        "valid_from": "<ISO timestamp of the reply>",
        "valid_to": null,
        "tags": ["onboarding", "provenance:workspace_onboarding"]
      }
    }
  ],
  "edges": [
    { "source": "k1", "target": "<owner-actor-uuid>", "type": "about" },
    { "source": "k1", "target": "<onboarding-session-object-id>", "type": "relates_to" }
  ]
}
```

For `north_star_metric`, swap the `about` target to the workspace id and set `subject_kind` / `subject_id` to `"workspace"` / `<workspace-uuid>`.

Field notes:
- `claim` is a one-sentence normalized restatement so downstream agents can reason without re-reading the raw reply.
- `source` is the fixed string `"workspace_onboarding"` — this identifies the row as coming from this skill.
- `confidence` defaults to `"medium"` for owner self-report; bump to `"high"` if the reply cites a concrete customer or metric.
- `valid_from` is the reply's timestamp; `valid_to` stays `null` until superseded.
- Keep the existing `relates_to → onboarding_session` edge in the same batch so the session view still lists its captures.

Do NOT write anything to the actor's `memory` field. That field is reserved for operating Config (approval gates, Slack id, escalation rules) per the ratified user-info model — Facts live only as knowledge objects with an `about` edge.

### 5. Close the session

After all five prompts are answered (or if the owner stops responding after 24h), update the onboarding session:
- `status: done`
- Add a closing comment: "Done — agents now have the context they need. Your first bet can start anytime."

## What NOT to do

- Do not run this for workspaces older than 24h, even if they have zero bets
- Do not post all five prompts at once — sequence matters; each answer informs the next question
- Do not create the onboarding session more than once per workspace
- Do not capture knowledge objects if the owner did not reply — only record actual answers
- Do not create the knowledge row and the `about` edge in separate calls — they must commit in the same `create_objects` transaction
- Do not write to `actors.memory` — that field is Config, not Facts
