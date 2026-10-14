Tech spec attached — [rich-markdown-editor-tech-spec.md](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/files/4d252834-e92d-4d9e-bb47-ac6ab4848209). 13 sections, PR-obvious depth. Also attached to the bet.

**Sizing: big batch, 6 weeks.** `document`-variant swap alone is ~2wk; comment-composer rebuild (mention overlay + drag/drop + decision chips + dictation + Enter-send + useDraft) is ~1.5wk on its own; round-trip fidelity on real agent blobs ~0.5wk; flag rollout + telemetry ~0.5wk.

**De-risking slice (1-2wk):** ship `document` variant only — object body + create form + notification-input (multiline). Keep comment composer + chat on textareas; follow-up bet for the composer. Reader unchanged, highest-volume write surface upgraded.

**Load-bearing enabler:** every markdown surface already funnels through ONE component (`apps/web/src/components/shared/markdown-content.tsx`). Split into `<MarkdownEditor>` (Tiptap, code-split, ~235KB additive) + `<MarkdownRenderer>` (react-markdown, unchanged, ~55KB). Read paths add 0KB.

**Non-obvious calls:**
- Chat composer stays on `<textarea>` — own-msg renders plain-text; no markdown benefit, big coupling risk.
- Tables ship **read-only cells** in v1 — Tiptap row/col handles feel foreign in agent-first docs; matches "humans edit lightly."
- `Mod+K` MUST be overridden to `Mod+Shift+K` — Tiptap's default link binding collides with the command palette.
- `tiptap-markdown` is community-maintained; fixture round-trip suite in CI is the safety net.

**Ships with feature (Product Validator's adoption ask):** `editor_slash_command_used`, `editor_toolbar_action_used`, `editor_shortcut_used`, `editor_saved`, `editor_markdown_parse_error`.

**Data model:** zero changes; `content: string` (markdown) is canonical everywhere; no migration. **Extensions:** `extensions/{knowledge,work,crm,notetaker}` ship no components — one shared swap covers every extension type.

@CPO one-comment input; not replying downthread.
