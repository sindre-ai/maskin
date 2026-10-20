# Draft card

How an agent's draft of an outbound text (email, LinkedIn post, LinkedIn message)
is shown, edited and approved. Source: the Maskin iOS v6 mockup ("Draft card" in
For you, "Draft in chat" in chats and flows).

## Problem

An agent that drafts outreach used to save the text in a knowledge object and
tell the person in chat that "the drafts are ready", with a link. The person had
to leave the chat to read, edit and approve. Drafts belong where the person is
already reading.

## The pattern

One card, three placements, one record.

| Placement | Density | Notes |
|-----------|---------|-------|
| Chat and flows | compact, inside the message | status badge in the header; long bodies fold to ~8 lines with Show all |
| For you ("Drafts to review") | full width | source agent and flow in the header; large primary button |
| Task page | the task's own content | same record, so same text |

Anatomy, top to bottom: kind chip (`EMAIL DRAFT`, `LINKEDIN POST`,
`LINKEDIN MESSAGE`) and status badge, then for email a read-only **To** and an
editable **Subject**, then the editable body (with `n / limit` when the channel has
a hard limit), then **Restore original** (only once edited) and the
verb-specific primary button (`Approve and send`, `Approve and post`).

States: **Draft** → **Edited** (text differs from what the agent wrote) →
**Approved** (text locks, receipt row with **Undo**). Undo returns to Draft.

## Rules

1. **The card is a view of a task, not a copy.** The task holds the text:
   `content` is the body, flat `draft_*` keys in `metadata` hold the rest
   (`draft_state`, `draft_subject`, `draft_original_subject`, `draft_original_body`,
   `draft_approved_at`). The keys are flat because object metadata is flat
   (`safeMetadataSchema`); a nested object is a 400. An edit in chat, For you or the
   task page is one edit. Like the Connect card, the card reads live and never
   stores state on the message.
2. **The message carries a pointer and the text.** `metadata.draft`
   (`messageDraftSchema`: task id, kind, `to`, `char_limit`) is backend-owned and
   stripped from client input. The message `content` is
   `formatDraftAsMarkdown(...)`, so MCP readers, notifications and search see the
   actual text. The two channels must say the same thing.
3. **Degrade to the markdown.** If the task is missing, or has no draft state, the
   card renders nothing and the quoted text in the message still reads.
4. **Approve records a yes; it does not send.** It sets `draft_state` to
   `approved`. Sending is the agent's job, triggered by that update.
5. **Edits save on blur**, to the task, never in the message. Approved text is
   locked until Undo.
6. **Hard limits block approval.** Over `char_limit` the counter turns
   destructive and the primary button is disabled (a LinkedIn connection note is
   300 characters).
7. **A revision supersedes.** When the agent redrafts, it posts a new card; the old
   card should read Superseded and lock. (Not built yet.)

## Built (slice 1)

- `packages/shared` — `messageDraftSchema`, `draftTaskStateSchema`,
  `readDraftTaskState`, `draftTaskStateToMetadata`, `formatDraftAsMarkdown`;
  `draft` is stripped from client metadata.
- `apps/web/src/components/chat/draft-card.tsx` — the compact card, wired into
  `message-bubble.tsx`. Plain `Textarea`; swap in the rich-markdown-editor's
  notification variant once that bet lands.

## Not built yet

- **Nothing writes `metadata.draft` yet.** Needs a backend route and an MCP tool
  (working name `post_draft`) that, in one transaction, creates the task with the
  draft state, posts the message with `metadata.draft` and the markdown content,
  logs the events, and accepts `Idempotency-Key`. Follow `connect-card` in
  `apps/dev/src/routes/sessions.ts`. Needs an integration test against real
  Postgres.
- **Approval trigger.** The update to `draft_state: approved` must wake the owning
  agent to send; decide between an event trigger and a task status move.
- For you "Drafts to review" section and the full-density variant.
- Superseded state, Apple (`apps/apple` has its own `MarkdownEditor.swift`), and the
  Playwright spec at 375/768/1024px (blocked on the writer, since no draft card can
  appear in a real chat yet).
- Agent guidance: the `outreach-drafts-in-chat-and-tasks` workspace skill should
  switch to `post_draft` once it exists.
