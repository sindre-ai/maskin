# Draft card

How an agent's draft of an outbound text (an email, or a post or message on any
channel) is shown, edited and approved. Source: the Maskin iOS v6 mockup ("Draft card" in
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

1. **The card is a view of an object, not a copy, and the object type is the workspace's
   choice.** Workspaces define their own object types, so nothing here hard-codes one.
   - A draft that already has a home (a LinkedIn post's `content` object) is **not**
     attached yet. Its body also holds the header, schedule and media brief, so writing
     the draft over it would delete them and break the scheduled publish. Attaching
     needs a shared helper that edits only the post text between the POST and MEDIA
     markers, with a hash version check; it is tracked on the For You draft-edit bet.
   - A new object is created for every chat draft. The agent picks its type with `object_type`
     (it reads `get_workspace_schema` to see what exists); the default is `task`, which
     is where emails and messages land when the workspace has no type of their own.
     The route checks the type against the workspace (400 listing the valid types).
   - New objects start in `status` if given, else `in_review` if the type has it, else
     a status that starts nothing. For a task that means skipping `todo` (dispatches a
     driver), `in_progress`, `validated`, `done` and `discarded`: backlog, or another
     waiting status, or a 400 asking for an explicit one. The row is written directly,
     so `POST /api/objects`' rule against creating a task already in review does not
     apply; nobody is meant to start this one.
   - Draft kinds are open identifiers (`email`, `linkedin_post`, `instagram_caption`,
     `tiktok_caption`, `slack_message`). Only `email` has its own layout (To and
     Subject). Everything else is plain text whose chip and button come from `label` and
     `approve_label`, or from the identifier. A new channel is a new string, not a code
     change.

   Either way the object holds the text: `content` is the body, flat `draft_*` keys in
   `metadata` hold the rest (merged into whatever metadata the object already has;
   the keys are flat because object metadata is flat, and a nested object is a 400).
   An edit in chat, For you or the task page is one edit. Like the Connect card, the
   card reads live and never stores state on the message.
2. **The message carries a pointer and the text.** `metadata.draft`
   (`messageDraftSchema`: object id, kind, `to`, `label`, `char_limit`) is backend-owned and
   stripped from client input. The message `content` is
   `formatDraftAsMarkdown(...)`, so MCP readers, notifications and search see the
   actual text. The two channels must say the same thing.
3. **Degrade to the markdown.** If the task is missing, or has no draft state, the
   card renders nothing and the quoted text in the message still reads.
4. **Approve records a yes, then says so in the chat.** Only a person can approve:
   the route refuses an agent with a 403, so "approved" always means a human agreed. It saves the approved text
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

## Sending an approved email

The card does not send anything; the agent does, with the `gmail_send_email` MCP tool
(`POST /api/integrations/gmail/send`, `apps/dev/src/routes/integrations-gmail.ts`).

- **Who may send** is the agent's access to Gmail in Settings → Integrations. Write access
  sends on its own; read-only or no access is refused with the usual access message.
- **Who needs a person.** A recipient marked off limits is the exception: a contact with
  `protected` or `email_opt_out`, a `loss_category` of `personal_protected`, or a contact
  who `works_at` a company marked `protected` (`send-guard.ts` lists them). The tool
  refuses and tells the agent to post a card. This is the one place to add a reason.
- **Approved draft.** With `draft_object_id`, the tool sends exactly the subject
  (`draft_subject`) and text (`content`) saved on the task, to the address on the card.
  It requires `draft_state: approved` **and** that the latest approve event on the task
  was made by a person: `POST /api/objects/:id/draft` accepts any workspace writer, so
  the state alone does not show a person agreed. The card's `to` must therefore hold a
  real address (`Mette Holm <mette@northwind.dk>`); a name alone is refused with
  instructions to redraft.
- **Once.** The send claims the task first (`draft_send_state: sending`, then `sent` or
  `unknown`), in one conditional UPDATE. A refusal from Gmail releases the claim; an
  unclear failure (5xx, dropped connection) locks it, because sending again could deliver
  it twice. A direct send is also refused if the same email went out in the last 24 hours.

Not yet: the card does not show a *Sent* state. It reads `draft_send_state` from the task
when someone builds that.

## Scaling to other channels

The aim is that adding Instagram, TikTok or any other platform is configuration and
data, not new code in every package.

Already true:
- The draft kind is an open identifier, and the card, route and `post_draft` tool have
  no per-platform code. A test drives an `instagram_caption` draft through all three.
- The object type and its statuses come from the workspace, not from constants.
- Limits are passed per draft (`char_limit`), never hard-coded.

Not yet true, and needed before a media post reads well on any channel:
- **Media.** The card shows text only. A post needs its media shown (image, several
  images, a video poster) with a role and an order per file, and attached files carry
  neither today.
- **Account, schedule, extras and "why".** These are read from typed lines inside a
  LinkedIn body today. They need to be fields (the format bet, "A post is only its
  text"), designed once for any channel.
- **Per-channel limits and wording** should live in one workspace-level place the
  agents read, so a limit is not repeated in every prompt.
- Anything that parses the LinkedIn marker format (splice helper, publish trigger) is
  LinkedIn-only by construction and is the part that does not scale.

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

## Decision: who owns the draft (A, chosen 2026-10-20)

A. **Task-backed (this PR stack).** The task holds the text; chat and For you are
   views of it. Gives drafts a structured home, which the For You bet says they lack.
   Two writers on `content` (human edits, agent revisions), mitigated by the agent
   posting a new card instead of editing.
B. **`draft_final` on the reply (For You spec).** One writer. Needs the card, route
   and tool reworked, and the chat card would read a decision block, not a task.

**Chosen: A, refined to object-backed.** Chat uses the object-backed draft (a content
object for a LinkedIn post, a task otherwise), and the For You card should point at the
same task instead of carrying its own `draft_final`. That needs the For You spec
amended by its Architect and CTO (storage model only; the always-editable box, Revert
to draft, plain text, the confirm tap and the flag stay as specified). Until they agree
the PRs stay drafts. For LinkedIn posts the conflict is sharper than for tasks: the
For You spec originally said the card never writes to the content object body; that was
reversed (see Outcome below), on the condition that only the post text is edited.

### Outcome (2026-10-20): Architect and CTO agreed, with conditions

The Architect rewrote the For You tech spec (v2) and the CTO approved the direction
(conditions file linked from the bet). It now reads and edits the object, not
`draft_final`. Conditions that bind this work:

- Edit only the post text, never the rest of the body; one shared helper for both
  cards. Not built; this PR therefore does not attach to content objects.
- Saves go through the server with a version check (a hash of the current text, under
  a row lock). This card still saves straight from the browser with a plain object
  update, which can overwrite an agent's newer text. **Known gap, must be fixed before
  anything writes to a real post.**
- Approve records a hash of the exact approved text on the reply, and the Copywriter
  refuses to publish on a mismatch. Chat approval does not do this yet.
- A LinkedIn message is edited on the send approval card, not in this box, which
  refuses that kind. Chat still accepts `linkedin_message`; whether it should refuse
  too is open.
- The rich editor rewrites the POST and MEDIA marker lines (tested headless by the
  Developer). The rich editor flag and the draft flag must not both be on for a
  content object until the editor locks those lines. Only 2 of 12 recent LinkedIn post
  objects use the marker format at all.

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
