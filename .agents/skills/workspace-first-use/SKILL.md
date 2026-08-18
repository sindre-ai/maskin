---
name: workspace-first-use
description: The Research Agent's half of first use — research the company behind a brand-new workspace, write what holds up as Knowledge, and put it in front of the owner to confirm before every other agent inherits it.
---

# First use — the context every agent starts from

## When to run

Only when a session hands you a first-use prompt naming the workspace, its owner
and the Strategist to hand off to. It runs once per workspace, immediately after
the workspace is created.

**Guard before anything else.** Call `list_objects` with `type: knowledge`. If
any object already carries `metadata.source = "workspace_first_use"`, first use
has already run — exit silently. Do not post, do not research, do not hand off.

## Why this exists

Everything every agent in this workspace does afterwards is argued from what you
write here. The owner has not told us anything yet — they signed up and landed on
a queue. So the job is to find what can be found, be explicit about the source of
each claim, and then ask the one question you genuinely cannot answer: is this
right?

## 1. Research

You have the workspace name, the owner's name, and their email domain. That is
usually enough to find the company. Use `web_search` and `web_fetch`.

Look for, in this order of usefulness:

- **What the company does** — the product, who pays for it, in the company's own
  words. The site is the source.
- **How this team is structured** — where the owner's function sits relative to
  the rest of the business.
- **Where work of this kind usually stalls** — the pattern across comparable
  teams, not a guess about this one.

Stop at three. A fourth thin claim costs more than it adds.

## 2. Write only what a source supports

Call `create_objects` **once**, with every knowledge node in the same batch.

For each one:

- `type: knowledge`, `status: draft` — it is not validated until the owner says so.
- `title` — the claim as a noun phrase ("What Acme does"), not a sentence.
- `content` — two or three sentences. What you found, and where.
- `metadata.source` — the fixed string `workspace_first_use`. The guard above
  reads this.
- `metadata.claim` — one-sentence normalised restatement.
- `metadata.provenance` — the URL or the named pattern the claim rests on. Every
  object needs one.
- `metadata.confidence` — `high` only when a primary source states it outright.
- `metadata.valid_from` — now, ISO.

**Leave out what you cannot source.** If the owner's seniority, team size or
roadmap is not stated anywhere you can check, do not write an object about it —
and say so in the card below. Naming the gap is worth more than filling it.

## 3. Put it in front of the owner

Create one `onboarding_session` object:

- `title: "The context every agent starts from"`
- `status: active`
- `content`: one line on what this card is for.
- `metadata.source`: `workspace_first_use`, `metadata.first_use_card`: `context`.

Then post **one** comment on it:

- Address the owner directly. Say what you read, what held up, and what you left
  alone because nothing supported it.
- Pass `refs` — one entry per knowledge object you wrote:
  `{ "kind": "object", "tag": "KNOWLEDGE", "label": "<title>", "object_id": "<id>", "detail": "<the source>" }`
- Pass `mentions: ["<owner actor id>"]` so the card reaches their queue.
- Pass `metadata.chips: ["Looks right", "Something is wrong", "Add a source"]`.
  These are the three replies that actually change what happens next; do not
  invent a fourth.

Say plainly that whether it is right is the one thing you cannot check yourself,
and that a correction now is cheaper than every agent inheriting a wrong reading.

## 4. Hand off

Post a second comment on the same card, `mentions` the Strategist actor id given
in your prompt, telling it the knowledge is written and it should draft the first
bet. That mention spawns their session — you do not draft the bet yourself.

Then stop. Do not wait for the owner's reply; if they correct something, a new
session brings it back to you.

## What NOT to do

- Do not write a knowledge object you cannot attribute to a source.
- Do not guess at the owner's role, seniority, or priorities.
- Do not create the knowledge objects in separate `create_objects` calls — one
  batch, so a half-written context can never be read by another agent.
- Do not set `status: validated` on anything the owner has not confirmed.
- Do not post more than two comments on the card.
- Do not write to the owner's `memory` field — facts live as knowledge objects.
