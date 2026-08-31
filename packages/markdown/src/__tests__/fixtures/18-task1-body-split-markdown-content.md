Split `apps/web/src/components/shared/markdown-content.tsx` into two components — read paths use `<MarkdownRenderer>` (react-markdown, no bundle add), write paths use `<MarkdownEditor>` (new Tiptap editor, code-split, dynamic-imported). Wire the full Tiptap extension set for the `document` variant with feature flag scaffolding and a malformed-Markdown fallback. This is the foundation every downstream task builds on.

Parent bet: [Rich Markdown editor across Maskin](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/666e3c4a-953a-4f57-b4a3-de6876b4bc01). Read the parent bet spec + the attached [tech spec](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/files/4d252834-e92d-4d9e-bb47-ac6ab4848209) (sections 1, 2, 5, 9, 12) before starting.

## Acceptance criteria (end-states)

- `<MarkdownRenderer>` exists in `packages/markdown` exporting the read-only surface (react-markdown + remark-gfm + remark-breaks + existing `code` override + `MentionedText` overlay), matches every prop on today's read-mode `MarkdownContent` (`content`, `className`, `size`, `disallowedElements`, `unwrapDisallowed`, `mentionActors`, `renderVisuals`), and read paths do not import Tiptap.
- `<MarkdownEditor>` exists in `packages/markdown` exporting the write surface, dynamic-imported (lazy `import()`), with the API in tech spec §5 (`value`, `onChange` fires on blur, `variant='document'|'comment'|'notification'`, ref with `focus`/`blur`/`insertContent`/`getMarkdown`/`clear`).
- `<MarkdownEditor>` mounts Tiptap `^2.10` with the full extension set below.
- `MarkdownContent` (the existing shared component) becomes a thin adapter: `editable=true` → `<MarkdownEditor variant='document'>`, `editable=false` → `<MarkdownRenderer>`. All existing call sites continue to compile and render without changes.

## In-scope

- The component split (`packages/markdown` refactor into `<MarkdownEditor>` + `<MarkdownRenderer>`).
- Tiptap extension wiring for the `document` variant (headings 1-3, bullet/ordered/task list, blockquote, code block with lowlight, inline code, link, table read-only cells, horizontal rule, bold/italic/strike, history, placeholder).
- Feature flag scaffold (`flags.rich_markdown_editor`).
- Malformed-Markdown fallback path (plain text render + PostHog event).
- Vite chunk-name CI assertion.
- Remove dead `rehype-raw` dep.
