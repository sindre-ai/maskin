## 2. Package + extension list

**Tiptap version:** `^2.10` (stable). v3 is still stabilizing (Dec 2025 as of Tiptap release history); v2 is production-grade.

**Direct additions:**

```jsonc
{
  "@tiptap/react": "^2.10",
  "@tiptap/pm": "^2.10",            // ProseMirror bundle (peer)
  "@tiptap/starter-kit": "^2.10",   // Doc, Paragraph, Text, Heading, Bold, Italic, Strike, BulletList, OrderedList, ListItem, Blockquote, HorizontalRule, Code, HardBreak, History, Dropcursor, Gapcursor — KEEP ALL EXCEPT CodeBlock (replaced below)
  "@tiptap/extension-code-block-lowlight": "^2.10",
  "lowlight": "^3.1",
  "highlight.js": "^11.10",         // /lib/common — ~30 common languages, ~30KB gzip
  "@tiptap/extension-link": "^2.10",
  "@tiptap/extension-placeholder": "^2.10",
  "@tiptap/extension-table": "^2.10",
  "@tiptap/extension-table-row": "^2.10",
  "@tiptap/extension-table-cell": "^2.10",
  "@tiptap/extension-table-header": "^2.10",
  "@tiptap/extension-task-list": "^2.10",
  "@tiptap/extension-task-item": "^2.10",
  "@tiptap/extension-bubble-menu": "^2.10",
  "@tiptap/extension-mention": "^2.10",  // for comment composer only
  "@tiptap/suggestion": "^2.10",         // foundation for hand-rolled slash menu
  "tiptap-markdown": "^0.8"             // markdown ↔ ProseMirror doc round-trip
}
```

**Choice justifications:**

- **StarterKit** — one dependency for the CommonMark core. Alternative (importing each node individually) is more code, same runtime cost.
- **CodeBlockLowlight over shiki** — lowlight is Tiptap's officially-supported syntax highlighter. `shiki` produces prettier output but ships ~200KB of themes/grammars gzip vs lowlight+hljs common ~55KB.

**Bundle math (gzipped, additive vs current):**

| Chunk | ~Size |
|---|---|
| ProseMirror bundle + Tiptap core (`@tiptap/pm` + `@tiptap/react`) | ~90 KB |
| StarterKit + Link + Placeholder + Table + TaskList + BubbleMenu | ~30 KB |
| CodeBlockLowlight + lowlight + hljs/common | ~55 KB |
| tiptap-markdown + markdown-it | ~40 KB |
| Suggestion + Mention + slash-menu impl | ~20 KB |
| **Total additive** | **~235 KB gzip** |
