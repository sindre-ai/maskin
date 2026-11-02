## 3. Markdown round-tripping

**Parser (load):** `tiptap-markdown` on `MarkdownEditor` mount — feeds markdown-it output into ProseMirror doc.

**Serializer (save):** `tiptap-markdown` serializer on `editor.getMarkdown()` — extends `prosemirror-markdown` with GFM tables, task lists, strike.

**Lossless coverage:** ATX headings (H1-H6), bold, italic, strike, inline code, links `[text](url)` (incl. Maskin's `[title](/<ws>/objects/<id>)` object-link shape — this is just a relative-URL link, not custom syntax), ordered/unordered lists w/ arbitrary nesting, blockquotes, horizontal rules, fenced code blocks with language, GFM tables, GFM task lists (`- [ ]` / `- [x]`), hard breaks (`  \n` from remark-breaks).

**Fidelity gaps and mitigations:**

| Feature | Behavior | Mitigation |
|---|---|---|
| Raw HTML in markdown (`<div>...`) | Dropped by parser (matches current sanitizer behavior in `packages/markdown/src/sanitize.ts`) | Consistent with today — no regression |
| ` ```chart ` fenced blocks (Maskin custom for inline recharts) | Preserved as `code_block` node at the doc level, serialized back verbatim to fenced code. **Rendered as a chart only in the reader** via the existing `code` component override in `markdown-content.tsx`. | No change to render path — reader owns visual, editor round-trips text |
| HTML comments `<!-- -->` | Dropped | Non-issue; agents don't emit these |
| Setext headings (`===`, `---` underline) | Normalized to ATX (`#`) on serialize | Non-issue; agents write ATX |
| Autolinks (bare `https://...`) | Normalized to `<url>` GFM autolink syntax | Non-issue |
| Nested blockquote with code | Preserved | Test covered |
| Escaped characters (`\*`, `\_`) | Preserved as text | Test covered |
