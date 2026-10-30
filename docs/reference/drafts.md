---
title: Drafts and previews
slug: drafts
description: How an agent drafts an email, a LinkedIn message or post, or a Slack message as an ordinary object, how a person previews, edits and approves it in chat, For You and Claude, how files (HTML, markdown, images) preview, and how it is sent.
last_updated: 2026-10-26
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

Agents learn this from the `draft-approval-tasks` skill, which every default agent carries (`DRAFT_APPROVAL_TASKS_SKILL` in `packages/shared/src/templates/default-workspace-agents.ts`; new workspaces get it when they are created). The `decision` field of `create_comment` repeats the one-line rule for agents without it.

## Kinds

| `metadata.kind` | Provider | Fields in `metadata` | Text limit | Send tool |
|---|---|---|---|---|
| `email` | Gmail | `to` (required), `cc`, `subject` (required) | 100,000 | `gmail_send_email({ object_id })` |
| `linkedin_message` | LinkedIn | `to` (recommended): a name or a profile link; `thread_id`, `reply_to`; `recipient_provider_id` (LinkedIn id, for a first message with no `thread_id`); `attachment_file_id` (one workspace PDF, PNG or JPEG up to 10 MB) | 8,000 | `reply({ object_id })` with a `thread_id`, `send_message({ object_id })` for a first message |
| `linkedin_connection_request` | LinkedIn | `to` (required), `recipient_provider_id` (required, the LinkedIn id the invitation goes to) | 300 | `send_connection_request({ object_id })` |
| `linkedin_inmail` | LinkedIn | `to` (required), `recipient_provider_id` (required, shown as "LinkedIn id"), `attachment_file_id`; no subject | 1,900 | `send_inmail` |
| `linkedin_post` | LinkedIn | `account` ("Posting as"), `scheduled_date`, `attachment_file_ids` (workspace PNG or JPEG file ids, comma separated, up to 9) | 3,000 | `publish_post({ object_id })` |
| `linkedin_comment` | LinkedIn | `post_id` (required, the post commented on), `to` (recommended): whose post it is | 3,000 | `comment_on_post({ object_id })` |
| `linkedin_comment_reply` | LinkedIn | `post_id` (required), `comment_id` (required, the comment answered), `reply_to` (the comment text, shown above the draft), `to` (recommended) | 3,000 | `reply_to_comment({ object_id })` |
| `linkedin_post_edit` | LinkedIn | `post_id` (required, a post this identity already published); the content is the new post text | 3,000 | `edit_post({ object_id })` |
| `slack_message` | Slack | `channel` (required): the name, `#coach-maskin`, never the id | 40,000 | `slack_send_message` |

LinkedIn tools are served per identity, so each is prefixed `linkedin-{account}-{identity}__`.

`send_message` and `reply` send through one path: the text, the recipient and the file are read from the approved object, never from the call, and the send is refused until a person has approved exactly this content and refused again once it has gone. `recipient_provider_id` and `attachment_file_id` are detail lines, so changing either withdraws the approval. `send_message` takes no `attachments`: a call that passes them gets `INVALID_INPUT`. A file is checked at send time: it must be in the caller's workspace, typed by its bytes (not its name), at most 10 MB, and not changed after the approval.

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
- **The card.** Contracted to its title, a click opens it. A draft names its kind ("Email", "LinkedIn post"), shows recipients and detail lines and the text, and ends in **Approve draft**. A draft of about 12 lines or fewer shows all its text and can be approved at once. A longer one shows its first 12 lines with **Show all**, and its button reads **Read full draft to approve**: the first tap opens the full text and sends nothing, then the button reads **Approve draft** and the next tap approves. If the draft changes afterwards, or the text is folded again, it is clamped again. So nobody approves text they did not see, and no part of the card scrolls on its own. Approving records the same `approved` event as answering a For You card, for exactly the text on screen, and tells the agent what was approved. Then it reads "Approved, waiting for send", and "Sent" after a send. A draft that carries a header (a LinkedIn post) shows only the text that goes out; it is edited on the object page.
- **The drawer.** The chat's Overview drawer (right rail on desktop, bottom sheet on small screens) has a **Linked** tab listing every object and file the conversation links, newest first, with who linked it and a jump to that message. Drafts and files are full cards there; every other object is the same reference card the transcript draws for a link on its own line. "Show in panel" on a card in the transcript opens the drawer on that item.
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

## Approve, then send

1. A person approves in one of two ways, and both leave the same `approved` event:
   - **Answering the card.** Choosing the send option on a decision card (or "Send: ... (id)" on one message of a stack) approves the draft behind it. The server reads this from the reply itself (`POST /api/events` with `parent_event_id`), in the same transaction as the reply, so every client approves without a second call and the agent the reply wakes already finds the approval. The approval covers the text as it reads when the reply arrives. Replies from an agent, or sent through MCP (`X-Client-Source: mcp`, where a model holds the person's key), never approve.
   - **The Approve button** (`POST /api/objects/:id/approval`, used by the chat card, the Claude card, and by web before it replies on For You). Only a person can: an agent gets 403. The body may carry the `content_hash` the person saw; if the draft changed since, the answer is 409. This is the stricter path, because it is bound to the exact text shown.
2. The approval is an `approved` event on the object carrying the hash. **Editing the recipients, subject or text changes the hash, which withdraws the approval.**
3. The agent sends. For an email: `gmail_send_email({ object_id })`. It needs "Read & write" access and a current approval: nothing is sent without a person's yes. One approval sends once (the same claim a decision card uses, keyed on the approval event). A send records a `delivered` event on the object and, when the object is a task, moves it to `done`, so nothing still says "to do" for an email that went out.
   For LinkedIn it is `reply({ object_id })` on the identity's tools: the text sent is the approved text read from the object (a `body` is refused), it is refused until a person has approved that exact text, refused once sent, and the conversation is the `thread_id` on the object or one the agent passes. There is no direct path: `reply`, `send_message`, `send_connection_request`, `publish_post`, `comment_on_post`, `reply_to_comment` and `edit_post` all refuse a call without `object_id` (`INVALID_INPUT`, "held for a person"), and nothing is sent.

In chat, the card for a linked draft ends in **Approve draft**: it approves the text as it reads in the card (an edit made there is what is approved), then tells the agent, naming the object id to send. The approval is not the send, so the card reads "Approved, waiting for send" until the send is recorded, and then "Sent".

In Claude, the Approve button calls `approve_object_draft`, an MCP tool with `visibility: ['app']`: hidden from the model, so a model cannot approve its own draft.

To have an agent send the moment a person approves (for example from the Claude card, where no reply comment wakes it), create an `event` [trigger](./notifications.md) on `entity_type` of the draft's type with `action: "approved"`.

## LinkedIn sends

The LinkedIn send tools (`send_message`, `reply`, `send_connection_request`, `publish_post`, `comment_on_post`, `reply_to_comment`, `edit_post`, `send_inmail`) take an `object_id`: the task or draft the send carries out. It is required. A call without it is refused with `INVALID_INPUT` ("held for a person") and nothing goes out. The text, the person and any file or images are read from the object, never from the call; passing them next to `object_id` is refused. The server checks the object before sending and ends it after:

- The object must exist in the workspace, be a draft of the kind the tool sends (`linkedin_message` for `send_message` and `reply`, `linkedin_connection_request`, `linkedin_post`, `linkedin_comment`, `linkedin_comment_reply`, `linkedin_post_edit`, `linkedin_inmail`), be complete, and carry a person's approval of exactly its current content. An edit withdraws the approval.
- A draft that was already sent is refused with `INVALID_INPUT` and nothing goes out. Create a new task for a new message.
- Once LinkedIn accepts the send, a `delivered` event is written on the object and a task moves to `done` (a `status_changed` event records it). A task already `done`, `validated` or `discarded` is left alone, and other object types get the event only.
- The tool's result carries `object: { id, delivered, task_closed }`, so the agent can see what happened and does not update the task itself.
- A failure to write the record never turns into an error: the send is gone, so the tool still reports success with `delivered: false`, and the failure is logged.

`delete_post` and `react_to_post` stay direct by decision. `edit_post` changes the text only: who may comment on the post is not part of a held edit. The post, the comment and the comment answered are detail lines on the draft, so changing one withdraws the approval. There is no HTTP route that comments or replies to a comment either; those go out only through the MCP tools.

## Older paths

A `create_comment` `decision` with `draft` / `drafts` and `gmail_send_email({ approval_comment_id })` still work. A draft whose object carries `metadata.kind` gets the richer preview on its card either way.
