---
title: Drafts and previews
slug: drafts
description: How an agent drafts an email or message as an ordinary object, how a person previews, edits and approves it in chat, For You and Claude, and how it is sent.
last_updated: 2026-10-21
---

# Drafts and previews

Anything an agent wants a person to review before it goes out (an email, a LinkedIn message, a Slack post) is an ordinary [object](./objects.md). There is no draft type and no draft tool. An object becomes a draft by carrying `metadata.kind`, and the integration that delivers that kind declares what it needs.

## Make a draft

```
create_objects({
  nodes: [{
    type: "task",
    title: "Email to Mette",
    content: "Hi Mette,\n\nThursday works.",          // the exact text that goes out
    metadata: { kind: "email", to: "Mette Holm <mette@northwind.dk>", cc: "dan@northwind.dk", subject: "Thursday" },
  }],
  // relate it to the contact or bet it concerns
})
```

Then mention the person with `create_comment`. No `decision` is needed; the object shows its own preview. Today the only kind is `email` (Gmail). `get_workspace_schema` does not list kinds yet; the send tool's description names the shape.

Kinds are declared in the provider's `config.ts` under `deliverables` (`DeliverableKind` in `apps/dev/src/lib/integrations/types.ts`): the kind name, its metadata fields, the body limit and the send tool. A new provider gets previews everywhere by adding that block, with no UI change.

## The preview

`GET /api/objects/:id`, `GET /api/objects/:id/graph`, `get_objects` and the For You feed return a `preview` for a draft, computed on read, never stored:

| Field | Meaning |
|---|---|
| `kind`, `label`, `provider` | What it is and who delivers it |
| `recipients` | `to` and `cc`, name and address |
| `subject`, `body` | Exactly what would go out. An older "Subject: ..." first line in the text is read as the subject |
| `missing` | Required fields that are empty. A draft with any cannot be approved |
| `warnings` | Things to check: an address that is not one, text over the limit |
| `content_hash` | Fingerprint of recipients, subject and text. An approval is bound to it |
| `delivery` | `draft`, `approved` or `sent`, read from the object's `events` |

The same `ObjectPreviewMeta` block renders it in chat, For You and the Claude card.

## Approve and send

1. A person approves in one of two ways, and both leave the same `approved` event:
   - **Answering the card.** Choosing the send option on a decision card (or "Send: ... (id)" on one message of a stack) approves the draft behind it. The server reads this from the reply itself (`POST /api/events` with `parent_event_id`), in the same transaction as the reply, so every client approves without a second call and the agent the reply wakes already finds the approval. The approval covers the text as it reads when the reply arrives. Replies from an agent, or sent through MCP (`X-Client-Source: mcp`, where a model holds the person's key), never approve.
   - **The Approve button** (`POST /api/objects/:id/approval`, used by the Claude card and by web before it replies). Only a person can: an agent gets 403. The body may carry the `content_hash` the person saw; if the draft changed since, the answer is 409. This is the stricter path, because it is bound to the exact text shown.
2. The approval is an `approved` event on the object carrying the hash. **Editing the recipients, subject or text changes the hash, which withdraws the approval.**
3. The agent sends with `gmail_send_email({ object_id })`. "Ask first" needs a current approval; "Read & write" may send without one unless a recipient is protected or opted out. One approval sends once (the same claim a decision card uses, keyed on the approval event). A send records a `delivered` event on the object.

In Claude, the Approve button calls `approve_object_draft`, an MCP tool with `visibility: ['app']`: hidden from the model, so a model cannot approve its own draft.

To have an agent send the moment a person approves (for example from the Claude card, where no reply comment wakes it), create an `event` [trigger](./notifications.md) on `entity_type` of the draft's type with `action: "approved"`.

## Older paths

A `create_comment` `decision` with `draft` / `drafts` and `gmail_send_email({ approval_comment_id })` still work. A draft whose object carries `metadata.kind` gets the richer preview on its card either way.
