---
title: Drafts and previews
slug: drafts
description: How an agent drafts an email, a LinkedIn message or post, or a Slack message as an ordinary object, how a person previews, edits and approves it in chat, For You and Claude, how files (HTML, markdown, images) preview, and how it is sent.
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

Then mention the person with `create_comment`. No `decision` is needed; the object shows its own preview. `get_workspace_schema` does not list kinds yet; this table is the list, and the send tool's description names the shape.

## Kinds

| `metadata.kind` | Provider | Fields in `metadata` | Text limit | Send tool |
|---|---|---|---|---|
| `email` | Gmail | `to` (required), `cc`, `subject` (required) | 100,000 | `gmail_send_email({ object_id })` |
| `linkedin_message` | LinkedIn | `to` (recommended): a name or a profile link; `thread_id`, `reply_to` | 8,000 | `reply({ object_id })` |
| `linkedin_connection_request` | LinkedIn | `to` (required) | 200 | `send_connection_request` |
| `linkedin_post` | LinkedIn | `account` ("Posting as"), `scheduled_date` | 3,000 | `publish_post` |
| `slack_message` | Slack | `channel` (required): the name, `#coach-maskin`, never the id | 40,000 | `slack_send_message` |

LinkedIn tools are served per identity, so each is prefixed `linkedin-{account}-{identity}__`.

A LinkedIn reply is a task filed with `channel: "linkedin_dm"` (that matches the kind, so `kind` is not needed) and `to` (who it goes to; without it the card warns "To is not filed"), `thread_id` (the conversation) and `reply_to` (the message being answered, shown above the draft):

```
create_objects({ nodes: [{
  type: "task", title: "Reply to Liz Benison",
  content: "Thanks Liz, ...",
  metadata: { channel: "linkedin_dm", to: "Liz Benison", thread_id: "<conversation id>", reply_to: "<her message>" },
}] })
```

A **LinkedIn post** also previews without any `kind` when the object has `metadata.content_type = "linkedin_post"`, which is how the Copywriter files them. The content may carry a header (account, voice, angle) above the copy; the preview shows only what lies between the `--- POST ---` and `--- MEDIA ---` lines, and nothing else is treated as the post. An explicit `kind` always wins over this match.

A kind is declared by its provider in `deliverables` (`DeliverableKind` in `apps/dev/src/lib/integrations/types.ts`). A text field with no `slot` shows as a labelled line in the preview (`details`); `slot: "hidden"` keeps one the send tool needs (a conversation id) off the card, and `slot: "context"` fills the text shown above the draft; those lines, like the recipients, subject and text, are part of what an approval is bound to, so changing the account a post is published as withdraws the approval. Approval is recorded for every kind. Only `email` and `linkedin_message` read their text from the object when sent by object id; for the others the agent is woken by the approval and sends with its own tool. A field may also be `recommended` (a warning when empty, not a block), and a kind matches through `alsoMatches` when `metadata.kind` is absent (an explicit `kind` wins).

A new provider gets previews everywhere by adding a `deliverables` block to its `config.ts` (kind name, metadata fields, body limit, send tool), with no UI change.

## The preview

`GET /api/objects/:id`, `GET /api/objects/:id/graph`, `get_objects` and the For You feed return a `preview` for a draft, computed on read, never stored:

| Field | Meaning |
|---|---|
| `kind`, `label`, `provider` | What it is and who delivers it |
| `recipients` | `to` and `cc`, name and address |
| `subject`, `body` | Exactly what would go out. An older "Subject: ..." first line in the text is read as the subject |
| `details` | Other facts about where it goes: `[{ label, value }]`, for example the account a post is published as, or a Slack channel |
| `context` | What the draft answers (a LinkedIn reply's `reply_to`). Shown above the text; not sent, so not in `content_hash` |
| `missing` | Required fields that are empty. A draft with any cannot be approved |
| `warnings` | Things to check: an address that is not one, text over the limit |
| `content_hash` | Fingerprint of recipients, subject, detail lines and text. An approval is bound to it |
| `delivery` | `draft`, `approved` or `sent`, read from the object's `events` |

The same `ObjectPreviewMeta` block renders it in chat, For You and the Claude card.

## The card on For You

The For You list is the Chief of Staff's. An agent that needs a person to decide posts a `create_comment` on the draft's task, @mentioning the Chief of Staff, with a `decision` (see `for-you-format`). For a message to be sent, the decision carries:

- `draft: { object_id, label, to }`. `object_id` is the draft object; the feed reads its current text and its preview live, so a later edit shows on the card. Never copy the text into `body`, the summary or the ask.
- `options` with **exactly one marked `destructive: true`**: the send option. A person choosing it is what approves the draft (see below). Several messages on one card use `drafts`, each with its own `id`.

A draft with no `kind` still shows its text. It just has no recipient lines and no approval.

A card can also be about a **file** instead of text: `draft: { file_id, label }`. The feed returns the file's name, type and size as `draft.file`, and the card draws the file itself, open, above the buttons (see Files). A `file_id` from another workspace, or a deleted file, shows nothing (the stored `body`, if any, is used instead).

A card disappears when its task reaches `done`, `archived`, `dismissed` or `discarded`, when the person replies, or when the notification's `only_while_status` no longer holds.

## In chat

A message that links an object (`/objects/<id>`) or a file (`/files/<id>`) shows a card **only for things a person acts on**: a draft with a preview, or a previewable file. A contact, a company or a plain task stays an ordinary link in the text.

- **Where.** A link that stands alone as a paragraph or a list item (a short lead-in ending in ":" is fine) is replaced by its card in place, so the message reads once. A link inside a sentence stays a link, and its card is added under the message. A card is never drawn twice for one link.
- **A link never vanishes.** The original link stays while the object loads, if it fails, if the object is missing or in another workspace, or if it does not deserve a card. Only a resolved card replaces it. Links inside code are not links.
- **The card.** Contracted to its title, a click opens it. A draft names its kind ("Email", "LinkedIn post"), shows recipients and detail lines, the whole text (never folded behind "Read all"), and ends in **Approve**. Approving records the same `approved` event as answering a For You card, for exactly the text on screen, and tells the agent what was approved. Then it reads "Approved", and "Sent" after a send. A draft that carries a header (a LinkedIn post) shows only the text that goes out; it is edited on the object page.
- **The drawer.** The chat's Overview drawer (right rail on desktop, bottom sheet on small screens) has a **Linked** tab listing every object and file the conversation links, newest first, with who linked it and a jump to that message. Drafts and files are full cards there; other objects are compact rows. "Show in panel" on a card in the transcript opens the drawer on that item.
- **Native apps.** The iOS and iPad apps draw the same cards in chat (in place or under the message), approve from them, and have a Linked sheet from the chat toolbar. The For You card shows the preview's recipients, subject, detail lines, approval state and files.

## Files

A file (`create_file`) previews as a card wherever it is linked or attached, by its type:

| Type | Drawn as |
|---|---|
| `text/html` | The page, in a sandboxed frame (`sandbox="allow-scripts"`, no same-origin access, the platform CSP). Scripts run; they cannot reach the app |
| `text/markdown` | Formatted markdown |
| `image/png`, `jpeg`, `gif`, `webp` and other images the browser cannot execute | The picture, open without a click |
| `text/plain`, JSON, YAML, XML | Preformatted text |
| SVG, JavaScript | Text only, never rendered |
| anything else (PDF, video, archives) | A header with the name, size and a link to the viewer |

Three places draw them: a chat message that links `/files/<id>`, a file attached to a comment or message, and a For You card with `draft.file_id`. Past 1.5 MB (8 MB for a picture) the card says the file is too large and links to the viewer. A file that is missing, or in another workspace, shows nothing.

## Approve and send

1. A person approves in one of two ways, and both leave the same `approved` event:
   - **Answering the card.** Choosing the send option on a decision card (or "Send: ... (id)" on one message of a stack) approves the draft behind it. The server reads this from the reply itself (`POST /api/events` with `parent_event_id`), in the same transaction as the reply, so every client approves without a second call and the agent the reply wakes already finds the approval. The approval covers the text as it reads when the reply arrives. Replies from an agent, or sent through MCP (`X-Client-Source: mcp`, where a model holds the person's key), never approve.
   - **The Approve button** (`POST /api/objects/:id/approval`, used by the chat card, the Claude card, and by web before it replies on For You). Only a person can: an agent gets 403. The body may carry the `content_hash` the person saw; if the draft changed since, the answer is 409. This is the stricter path, because it is bound to the exact text shown.
2. The approval is an `approved` event on the object carrying the hash. **Editing the recipients, subject or text changes the hash, which withdraws the approval.**
3. The agent sends. For an email: `gmail_send_email({ object_id })`. It needs "Read & write" access and a current approval: nothing is sent without a person's yes. One approval sends once (the same claim a decision card uses, keyed on the approval event). A send records a `delivered` event on the object and, when the object is a task, moves it to `done`, so nothing still says "to do" for an email that went out.
   For LinkedIn it is `reply({ object_id })` on the identity's tools: the text sent is the approved text read from the object (a `body` is refused), it is refused until a person has approved that exact text, refused once sent, and the conversation is the `thread_id` on the object or one the agent passes. Sending with a `thread_id` and a `body` and no object is unchanged and needs no approval; `object_id` is the path for drafts a person was asked to approve.

In chat, the card for a linked draft ends in **Approve and send**: it approves the text as it reads in the card (an edit made there is what is approved), then posts a message mentioning the agent that names the object id to send. Once the send is recorded, the card shows "Sent".

In Claude, the Approve button calls `approve_object_draft`, an MCP tool with `visibility: ['app']`: hidden from the model, so a model cannot approve its own draft.

To have an agent send the moment a person approves (for example from the Claude card, where no reply comment wakes it), create an `event` [trigger](./notifications.md) on `entity_type` of the draft's type with `action: "approved"`.

## LinkedIn sends

The LinkedIn send tools (`send_message`, `reply`, `send_connection_request`) take an optional `object_id`: the task or draft the message carries out. With it, the server checks the object before sending and ends it after:

- The object must exist in the workspace, and must not already carry a `delivered` event. A second send of the same object is refused with `INVALID_INPUT` and nothing goes out, whatever the new text. Create a new task for a new message.
- Once LinkedIn accepts the message, a `delivered` event is written on the object and a task moves to `done` (a `status_changed` event records it). A task already `done`, `validated` or `discarded` is left alone, and other object types get the event only.
- The tool's result carries `object: { id, delivered, task_closed }`, so the agent can see what happened and does not update the task itself.
- A failure to write the record never turns into an error: the message is gone, so the tool still reports success with `delivered: false`, and the failure is logged.

Without `object_id` a send behaves as before and nothing is recorded.

## Older paths

A `create_comment` `decision` with `draft` / `drafts` and `gmail_send_email({ approval_comment_id })` still work. A draft whose object carries `metadata.kind` gets the richer preview on its card either way.
