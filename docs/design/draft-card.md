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
4. **Approve records a yes, then says so in the chat.** It saves the approved text
   and `draft_state: approved` on the task, and only once that is saved posts a
   message in the conversation mentioning the drafting agent ("Approved the email to
   Mette. Send it exactly as saved in task ..."). The agent receives that as its next
   turn, reads the task and sends. No trigger configuration is needed, and the
   approval is visible in the thread. Undo flips the task back and posts nothing, so
   the agent is told to send only if the state is still `approved`.
5. **Edits save on blur**, to the task, never in the message. Approved text is
   locked until Undo.
6. **Hard limits block approval.** Over `char_limit` the counter turns
   destructive and the primary button is disabled (a LinkedIn connection note is
   300 characters).
7. **A revision supersedes.** When the agent redrafts, it posts a new card; the old
   card should read Superseded and lock. (Not built yet.)

## Related bets

Read before changing the storage model or the editor.

- **Rich Markdown editor across Maskin** (bet 666e3c4a). Chat and comment composers
  stay on a plain textarea, and the CPO decided drafts go out as plain text, so this
  card does **not** use the rich editor. Email formatting is an open question in the
  For You bet; if it is ever rich, it applies to the email body only.
  *Risk, untested:* the draft lives in the task's `content`, and task bodies open in
  the TipTap editor once its flag is on. Plain text with line breaks or markdown-like
  characters could be rewritten by a round trip, changing the text that is sent.
  Check before enabling both.
- **Humans fix a LinkedIn post or email draft on the For You card** (bet be4ce70f,
  at signal, tech spec CTO-approved 2026-10-19, flag `foryou-draft-edit`). Same user
  need, **different storage model**: that spec writes the edit as a server-stamped
  `draft_final` on the reply and says the card never writes to the content object, so
  one writer owns the body. This card writes the edit to a task. They have to be
  reconciled before either ships; see Open decision.
  Also from that spec: email waits for slice 2 and has no stored subject; LinkedIn
  messages and replies are already gated by the send approval card, so editing them
  here would ask for approval twice; a Sending option needs one confirm tap; go-live
  is gated on PostHog product events flowing again; scheduled after the Slack send
  line (about 2026-11-10), behind the file editor build.
- **Sends wait for a person who can see the real recipient** (bet 5b25707d). Approving
  here asks the agent to send through its normal tools, so that gate still applies to
  the send itself.

## Open decision: who owns the draft

A. **Task-backed (this PR stack).** The task holds the text; chat and For you are
   views of it. Gives drafts a structured home, which the For You bet says they lack.
   Two writers on `content` (human edits, agent revisions), mitigated by the agent
   posting a new card instead of editing.
B. **`draft_final` on the reply (For You spec).** One writer. Needs the card, route
   and tool reworked, and the chat card would read a decision block, not a task.

Leaning A for chat with the For You card pointing at the same task, which means the
For You spec is amended by its Architect and CTO. Not decided. The PRs are held as
drafts until it is.

## Built

**Slice 1 (PR #2224)**
- `packages/shared`: `messageDraftSchema`, `draftTaskStateSchema`,
  `readDraftTaskState`, `draftTaskStateToMetadata`, `formatDraftAsMarkdown`;
  `draft` is stripped from client metadata.
- `apps/web/src/components/chat/draft-card.tsx`: the compact card, wired into
  `message-bubble.tsx`. A plain `Textarea`, on purpose: drafts go out as plain text
  (see Related bets).

**Slice 3: approval wakes the agent**
- `DraftCard` posts the approval message after the task update succeeds.

**Slice 2: the writer**
- `POST /api/sessions/:id/draft` (`apps/dev/src/routes/sessions.ts`) creates the task
  and posts the card message in one transaction, so a chat never shows a card for
  a task that does not exist. The task is `in_review`, driven by the agent that
  posted it; a `created` event is logged. Same gate as `/connect-card`: only the
  agent that owns an interactive chat session may post (403 / 404 / 409 otherwise).
  Email needs `to` and `subject`, and a body over `char_limit` is a 400.
- MCP tool `post_draft` (`packages/mcp`). In a session with no chat it returns an
  error telling the agent to make the task itself; a validation failure reaches the
  agent as the server's message so it can fix the draft.
- Integration test against real Postgres:
  `apps/dev/src/__tests__/integration/session-draft.test.ts`. It also asserts the
  stored metadata passes `updateObjectSchema`, so edits and approval can save.

## Not built yet

- **Closing the loop after sending.** Nothing marks the task done once the agent has
  sent; the agent should move it out of `in_review` itself. A `sent` draft state would
  stop a late Undo from implying the text can still be changed.
- Approving from For you (no conversation on screen) reuses the message's
  conversation, which the placement will need to pass in.
- For you "Drafts to review" section and the full-density variant.
- Superseded state, Apple (`apps/apple` has its own `MarkdownEditor.swift`), and the
  Playwright spec at 375/768/1024px (needs a seeded draft message).
- Agent guidance: switch the `outreach-drafts-in-chat-and-tasks` workspace skill to
  `post_draft`.
- `apps/apple/openapi.json` is not refreshed here; the Apple workflow only runs on
  `apps/apple` changes and the snapshot was already stale.
