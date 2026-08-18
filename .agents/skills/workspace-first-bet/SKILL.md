---
name: workspace-first-bet
description: The Strategist's half of first use — read the Knowledge the Research Agent wrote about a brand-new workspace, draft the one bet worth opening first, and put the open-or-hold call to the owner.
---

# First use — the first bet

## When to run

Only when the Research Agent @mentions you on a first-use context card. It runs
once per workspace.

**Guard before anything else.** Call `list_objects` with `type: bet`. If the
workspace already has a bet, first use has already produced one — exit silently.

## Why this exists

A workspace with nothing in it gives the owner nothing to decide. One bet, argued
from what was actually researched, is the smallest thing that makes the product
legible: here is a scoped hypothesis, here is the evidence, here is the one call
only you can make.

## 1. Read the context

Call `list_objects` with `type: knowledge` and read every object carrying
`metadata.source = "workspace_first_use"`. That, plus their `provenance`, is your
whole evidence base. You have no customer data, no history, and no roadmap —
do not write as if you do.

## 2. Draft one bet

Pick the single thing where the evidence is strongest, not the most ambitious
one. Create it with `create_objects`:

- `type: bet`, `status: signal` — the stage before anything is real. Nothing is
  scoped, nothing is assigned, no agent picks up work against a signal. This is
  deliberately earlier than the `qualified` entry stage in `shape-and-run-a-bet`:
  nothing about a first-use bet has been through discovery, and For You renders a
  bet in `signal` as a proposal with open / refine / dismiss. Once the owner opens
  it, `shape-and-run-a-bet` is the method from there on.
- `title` — what would change, in the owner's language.
- `content` — four short parts, in this order:
  - **Goal** — the outcome, with a number if the evidence supports one.
  - **Evidence** — which knowledge objects argue for it, and what they rest on.
  - **Timeline** — one cycle, with a mid-point review.
  - **Stops for you** — what this bet would never do without asking.
- `metadata.source`: `workspace_first_use`.
- Edge it `relates_to` every knowledge object you argued from, in the same
  `create_objects` batch. A bet with no edge back to its evidence is an
  assertion, not a bet.

## 3. Put the call to the owner

Post **one** comment on the bet:

- Say what you read and why this one rather than the others.
- Pass `refs` — the knowledge objects behind it, so the owner can open the
  argument rather than take your word:
  `{ "kind": "object", "tag": "KNOWLEDGE", "label": "<title>", "object_id": "<id>" }`
- Pass `mentions: ["<owner actor id>"]`.
- Name the decision honestly: open it now, hold it while more evidence gathers,
  or drop it and bring the next one. Say what each choice actually does, and say
  which is reversible.

A bet in `signal` renders in For You as a proposed bet, so the owner gets those
options as buttons — your comment supplies the reasoning under them, not a
restatement of the buttons.

## 4. Stop

Do not draft tasks. Do not move the bet out of `signal`. Do not assign anyone.
Everything after the owner's call belongs to a different session.

## What NOT to do

- Do not invent evidence, numbers, or customer quotes.
- Do not open more than one bet.
- Do not create the bet without its `relates_to` edges in the same batch.
- Do not post a second comment chasing a reply — an unread card comes back on
  its own.
