---
name: workspace-observer-onboarding
description: Guides the Workspace Observer to run onboarding for a new workspace — detecting an empty workspace, creating an onboarding session, subscribing the owner, and posting context prompts in sequence to get the workspace to its first bet.
---

# Workspace Observer Onboarding

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

### 3. Post prompts in sequence

Post the five prompts below as comments on the onboarding session object, in order. **Wait for a reply to each prompt before posting the next one.** Capture each reply as a knowledge object (see step 4).

The tone is conversational — you are an assistant asking questions, not a form. Write each prompt as a short message.

**Prompt 1 — Product vision**
> What does your product do and who is it for? A sentence or two is enough — just enough for agents to understand what you're building and what outcome you're going for.

**Prompt 2 — ICP**
> Who is your ideal customer? The sharper the better — role, company type, the specific pain they have. If you have real customers already, describe one of them.

**Prompt 3 — First-bet hypothesis**
> What's the single most important thing to figure out or build right now? This becomes your first bet — what would move the needle most if it worked?

**Prompt 4 — North Star metric**
> How will you know the product is working? Name one number — the metric that, if it goes up, you're succeeding.

**Prompt 5 — Customer evidence**
> What have you already heard from customers or potential customers? Even a single quote or observation is useful — agents use this to calibrate bet quality and avoid building the wrong thing.

### 4. Capture responses as knowledge objects

After each reply, call `create_objects` to save the response:
- `type: knowledge`
- `title`: a short label for the response (e.g. "Product vision", "ICP", "North Star metric")
- `status: active`
- `content`: the owner's reply verbatim, or a clean restatement if the reply is conversational
- Link the knowledge object to the onboarding session via a `relates_to` relationship

### 5. Close the session

After all five prompts are answered (or if the owner stops responding after 24h), update the onboarding session:
- `status: done`
- Add a closing comment: "Done — agents now have the context they need. Your first bet can start anytime."

## What NOT to do

- Do not run this for workspaces older than 24h, even if they have zero bets
- Do not post all five prompts at once — sequence matters; each answer informs the next question
- Do not create the onboarding session more than once per workspace
- Do not capture knowledge objects if the owner did not reply — only record actual answers
