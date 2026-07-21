# State-of-the-art object editor

Object detail pages edit via a raw textarea while agents write via MCP. A Notion/Linear-grade Markdown editor makes Maskin credible as a product team's AI knowledge base and closes the live silent-clobber bug.

## Chosen direction

TipTap (MIT core) + owned remark-based Markdown serializer, per the attached decision report.

## Success

100% zero-diff round-trip on the GFM corpus in CI, on every PR to the bet branch. Baseline: no editor round-trip today (textarea passthrough). Timeframe: 6 weeks.

## Acceptance criteria

- Done when the object detail page renders a TipTap editor replacing the textarea, with an explicit edit mode and debounced autosave.
- Done when the GFM round-trip corpus passes zero-diff on untouched blocks in CI.
- Done when a version-mismatched PATCH returns 409 and the editor shows a reconcile banner.

## Exit criteria

If the owned remark serializer can't reach zero-diff on untouched blocks by 2026-08-31, or TipTap MIT-tier regresses on a feature named in Acceptance criteria, or React 19 breaks land without upstream fixes — switch to Milkdown/Crepe (same ProseMirror substrate).
