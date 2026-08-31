// Headless Markdown ↔ Tiptap round-trip helper.
//
// Mirrors the extension set that `<MarkdownEditor variant='document'>` mounts
// in `./react/editor.tsx` — same StarterKit configuration, same code-block +
// link + table + task-list wiring, same `tiptap-markdown` options. The React
// editor and the CI fixture suite must exercise the same pipeline; if they
// drift, the fixture guarantee becomes a fiction.
//
// Used by:
//   - `src/__tests__/roundtrip.test.ts` — real agent-generated fixture suite
//   - `src/__tests__/block-types.test.ts` — per-block-type + edge-case tests
//
// Note: `new Editor()` needs a DOM. Vitest supplies one via `environment:
// 'jsdom'` (see `vitest.config.ts`). Callers outside a browser or jsdom
// environment must set one up first.

import { Editor } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Link from '@tiptap/extension-link'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { Markdown } from 'tiptap-markdown'

const lowlight = createLowlight(common)

function buildEditor(markdown: string): Editor {
	return new Editor({
		extensions: [
			// Match `document` variant in editor.tsx: keep all StarterKit nodes
			// except CodeBlock (replaced by lowlight), and expose H1–H6 so the
			// fixture suite can exercise every ATX level. The React editor caps
			// at H1–H3 for UX; the round-trip layer must not, or agent-generated
			// H4+ headings silently degrade to paragraphs.
			StarterKit.configure({
				codeBlock: false,
				heading: { levels: [1, 2, 3, 4, 5, 6] },
			}),
			CodeBlockLowlight.configure({ lowlight }),
			Link.configure({
				openOnClick: false,
				autolink: true,
				HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
			}),
			Markdown.configure({
				html: false,
				tightLists: true,
				bulletListMarker: '-',
				linkify: false,
				breaks: true,
				transformPastedText: true,
				transformCopiedText: true,
			}),
			Table.configure({ resizable: false }),
			TableRow,
			TableHeader,
			TableCell,
			TaskList,
			TaskItem.configure({ nested: true }),
		],
		content: markdown,
	})
}

/**
 * Parse Markdown → Tiptap doc, serialize back to Markdown. One pass.
 *
 * The first pass may normalize the input (setext → ATX headings, autolinks
 * wrapped in `<>`, etc.). Callers that need an idempotence check should run
 * this twice and compare the two outputs — see `assertIdempotent`.
 */
export function roundTrip(markdown: string): string {
	const editor = buildEditor(markdown)
	try {
		return editor.storage.markdown.getMarkdown() as string
	} finally {
		editor.destroy()
	}
}

/**
 * Idempotence check: `serialize(parse(serialize(parse(md)))) === serialize(parse(md))`.
 *
 * Returns `{ ok: true }` if the second pass matches the first (stable
 * normalization), or `{ ok: false, first, second }` with both outputs so the
 * caller can diff them.
 */
export function assertIdempotent(
	markdown: string,
): { ok: true; normalized: string } | { ok: false; first: string; second: string } {
	const first = roundTrip(markdown)
	const second = roundTrip(first)
	if (first === second) return { ok: true, normalized: first }
	return { ok: false, first, second }
}
