Lightweight rich Markdown editor across Maskin, designed agent-first: agents write the bulk of content, humans read and edit lightly.

**Design philosophy:** Agent-first. The editor must render agent-generated Markdown beautifully and give humans a fluent editing experience — not the other way around.

---

## Surfaces

V1 ships the `document` variant only:
- Object bodies (bet, task, knowledge, insight)
- Object descriptions
- Create/edit forms

Comment composer and chat stay on `<textarea>` in v1 — own-message renders plain-text, no Markdown benefit, coupling risk too high. Comment-composer upgrade is a follow-up bet.

Feed, notifications, and chart previews reuse `<MarkdownRenderer>` (read-only) — no editor mounted.

---

## Tiptap extension set

| Extension | Notes |
|---|---|
| Document, Paragraph, Text | Core |
| Heading (levels 1–3) | H1 22/28, H2 18/26, H3 16/24 |
| BulletList, OrderedList, ListItem | Standard |
| TaskList, TaskItem | Checkbox lists |
| Blockquote | 2px brand-subtle left rule |
| CodeBlock (shiki, github-dark) | Lang chip + copy on hover |
| InlineCode | bg-muted px-1 font-mono |
| Link | Mod+Shift+K (overrides Tiptap default Mod+K — collides with command palette) |
| Table | Read-only cells in v1; 3×3 insert only |
| HorizontalRule (divider) | |
| Bold, Italic, Strike | |
| History | Undo/redo |
| Placeholder | "Write, or press / for commands" |

Bundle: configure and skin existing extensions only — do not build from scratch.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Mod+B | Bold |
| Mod+I | Italic |
| Mod+Shift+S | Strikethrough |
| Mod+E | Inline code |
| Mod+Shift+K | Link (overrides Tiptap default Mod+K) |
| Mod+Z | Undo |
| Mod+Shift+Z | Redo |
| Tab | Indent list |
| Shift+Tab | Outdent list |
| `/` (at block start) | Open slash menu |
| Escape | Close slash menu |

"Mod" = Cmd on Mac, Ctrl on Windows/Linux.
