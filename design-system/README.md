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
