---
name: workspace-observer-onboarding
description: Guides the Workspace Coach to run onboarding for a new workspace — detecting an empty workspace, creating an onboarding session, subscribing the owner, and posting five context prompts in a fixed dependency order (vision → hypothesis → ICP → North Star → evidence) with skip-logic that converts to a confirmation when prior research already answered a layer at high confidence.
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

To find the workspace owner: list workspace members and identify the human actor (type != "agent") who created the workspace or is listed as owner.

### 3. Post prompts in dependency order

Post the five prompts below as comments on the onboarding session object, **strictly in the order given**. Each prompt depends on the answer to the one before it — do not reorder, batch, or parallelise. Wait for a reply to each prompt (or the 24h stop rule below) before posting the next.

The five prompts form a directed acyclic dependency chain: `product_vision → first_bet_hypothesis → icp → north_star_metric → customer_evidence`. Every downstream prompt personalises its ask using answers already captured upstream — that is why the order is fixed.

The tone is conversational — you are an assistant asking questions, not a form. Write each prompt as a short message.

**Prompt 1 — Product vision** (`product_vision`)
> What does your product do and who is it for? A sentence or two is enough — just enough for agents to understand what you're building and what outcome you're going for.

Vision comes first because it frames every downstream prompt. It must come from the owner — intent cannot be inferred from a website.

**Prompt 2 — First-bet hypothesis** (`first_bet_hypothesis`)
> What's the single most important thing to figure out or build right now? This becomes your first bet — what would move the needle most if it worked?

The bet hypothesis is the highest-leverage input after vision. It must come from the owner. If prior research surfaced a current-challenge or timing trigger for this owner, personalise the prompt with it, e.g. "You mentioned Y is your current challenge — what's the one thing to figure out or build right now that would move the needle on that?"

**Prompt 3 — ICP** (`icp`)
> Who is your ideal customer? The sharper the better — role, company type, the specific pain they have. If you have real customers already, describe one of them.

ICP is who the bet is delivered to — ask it after vision and hypothesis so the framing is concrete. If prior research yielded firmographic signals, name them in the prompt so the owner is confirming, not repeating.

**Prompt 4 — North Star metric** (`north_star_metric`)
> How will you know the product is working? Name one number — the metric that, if it goes up, you're succeeding.

The North Star depends on vision + ICP being known. If prior research inferred a candidate metric for this stage/segment, present it for confirmation instead of asking cold: "Given your vision and ICP, we'd expect the North Star to be *X* — is that right, or would you name a different one?"

**Prompt 5 — Customer evidence** (`customer_evidence`)
> What have you already heard from customers or potential customers? Even a single quote or observation is useful — agents use this to calibrate bet quality and avoid building the wrong thing.

Evidence comes last — it grounds the bet once vision, hypothesis, ICP, and North Star exist to organise it around.

### 3a. Skip-logic — never re-ask what prior research already answered

Before posting **each** prompt, check whether prior research already captured the answer for this workspace at high confidence, and adapt the prompt accordingly. Perform these steps in order:

1. **Search for prior knowledge on this layer.** Call `search_objects` (or `list_objects` filtered by `metadata_eq`) for `type: knowledge` objects in this workspace, filtering by a topic tag or prompt-type field matching the current prompt (e.g. `topic:product_vision`, `topic:north_star_metric`). Also fetch any `about → actor` (owner) or `about → workspace` knowledge on that topic.
2. **Read confidence.** Check the `confidence` field on the metadata of each match (Phase-1 research writes this as a numeric `0.0`–`1.0`; some rows use the literal strings `"low" | "medium" | "high"` — treat `"high"` as `≥ 0.8`).
3. **Decide the prompt shape:**
   - **`confidence ≥ 0.8` → convert to a confirmation card.** Do not ask the open question. Post: *"We think your <layer> is: *<candidate value>*. Confirm, correct, or rewrite — a one-liner is fine."* Capture the reply as an update to the existing knowledge object (`update_objects`) rather than creating a new row — preserve the existing `about` edge; append the owner's confirmation to `content` and bump `confidence` to `1.0` with `provenance: "owner_confirmed"`.
   - **`0.4 ≤ confidence < 0.8` → ask with a candidate.** Post the open prompt but include the current best guess as a nudge: *"<open question> — for context, our current guess is *<candidate>*."*
   - **No prior knowledge, or `confidence < 0.4` → ask the open prompt** (verbatim as written above).
4. **Never re-ask an already-confirmed layer.** If a knowledge row for this layer already carries `provenance: "owner_confirmed"` (regardless of confidence), skip the prompt entirely and mark the `workspace_onboarding_prompts` row `answered_at = now()` referencing that existing object.
5. **Validate the DAG before advancing.** Before posting prompt *N*, confirm every dependency ≤ *N*-1 is either answered by the owner in this session, or was confirmed via skip-logic. If any upstream layer is missing (an orphan), post that upstream prompt first — never post a downstream prompt on top of an unanswered upstream one. There is no cycle to check (the order is fixed and enforced by this skill), but never advance past an orphan.

The chain is: `product_vision → first_bet_hypothesis → icp → north_star_metric → customer_evidence`. All five prompts are owner-targeted except `north_star_metric`, which is workspace-targeted (see step 4).

### 4. Capture responses as knowledge objects

After each reply, call `create_objects` to save the response:
- `type: knowledge`
- `title`: a short label for the response (e.g. "Product vision", "ICP", "North Star metric")
- `status: active`
- `content`: the owner's reply verbatim, or a clean restatement if the reply is conversational
- `metadata.topic`: the prompt-type tag (e.g. `product_vision`, `first_bet_hypothesis`) — skip-logic in future sessions searches by this tag
- `metadata.provenance`: `"owner_provided"` (or `"owner_confirmed"` if the reply confirmed a skip-logic candidate)
- `metadata.confidence`: `1.0` — owner-supplied answers are ground truth
- Link the knowledge object to the onboarding session via a `relates_to` relationship

Owner-targeted vs workspace-targeted classification (used by the write-path that attaches the `about` edge): `product_vision`, `first_bet_hypothesis`, `icp`, and `customer_evidence` are **owner-targeted** — the fact is about the workspace owner. `north_star_metric` is **workspace-targeted** — the fact is about the workspace itself. Downstream skip-logic reads whichever target the write-path attached; both are searchable.

Also update the `workspace_onboarding_prompts` row for this prompt-type: set `answered_at = now()` and `object_id` to the newly-created knowledge row's id, so the DB reflects that this layer is done.

### 5. Close the session

After all five prompts are answered (whether by owner reply or skip-logic confirmation), or if the owner stops responding after 24h, update the onboarding session:
- `status: done`
- Add a closing comment: "Done — agents now have the context they need. Your first bet can start anytime."

## What NOT to do

- Do not run this for workspaces older than 24h, even if they have zero bets
- Do not post the five prompts out of order or in parallel — the chain is `vision → hypothesis → ICP → NSM → evidence`
- Do not re-ask a layer that prior research already answered at high confidence — convert to a confirmation card instead
- Do not create the onboarding session more than once per workspace
- Do not capture knowledge objects if the owner did not reply — only record actual answers
- Do not write a knowledge object without its `about` edge — a bare owner-fact with no `about → actor` is malformed
