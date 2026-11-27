# Design system patterns

New patterns land here in the PR that introduces them, with one line on why the existing
patterns do not do the job. Reuse a pattern before adding one (see `.claude/rules/frontend.md`).

## Keychain: in-chat credential capture

- **SecretDetectedCard** (`apps/web/src/components/chat/secret-detected-card.tsx`): the card the
  composer shows when a send is stopped because the text holds a provider secret. Indigo for a
  certain match, amber for a doubtful one. Existing chat cards (tool-call cards, system rows) are
  passive and have no primary/secondary/cancel decision row, and none can block the composer.
- **InlineScopePicker** (`apps/web/src/components/chat/inline-scope-picker.tsx`): choose which
  agents may use a credential without leaving the conversation. The Keychain scope sheet is a
  right-hand sheet that would pull the user out of the message they are in the middle of sending.
- **TranscriptRedactedRow** (`apps/web/src/components/chat/transcript-redacted-row.tsx`): the row
  that stands where a vaulted message was, so the transcript visibly says it was rewritten.
  `MessageDivider` is a 10.5px label with no room for the redaction marker, and a normal bubble
  would present the rewrite as something the user typed.

## For You: decision card

- **Docked card footer** (`apps/web/src/components/foryou/feed-card.tsx`): the decision options, pinned to the bottom edge of the feed scroller while their card is on screen and back in flow after the draft at the card's end, with a shadow only while docked. The answers must stay after the draft, because approving text you could not read in full is not approving it, so the control cannot be moved above the message; and nothing else in the app makes a control visible without reordering the content it belongs to. The card shell uses `overflow-clip`, not `overflow-hidden`, so `position: sticky` resolves against the feed scroller instead of the card.

## Agent change review

- **ChangeReview** (`apps/web/src/components/files/change-review.tsx`): the proposal banner above a
  markdown file, the review view that stands in for the editor, and one card per proposed change
  with Edit, Reject and Accept and a word-level diff (`del` / `ins`, never colour alone). Nothing
  in the app reviews a proposed replacement of text: `ReviewPanel` reviews comments, not
  replacements, and a plain diff viewer has no accept, edit or reject per change. The blocks
  around a change and the "N unchanged block(s)" rows are built from the current file text, not
  from stored context. Behind the **agent-change-review** flag.
