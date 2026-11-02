// Headless Markdown ↔ Tiptap round-trip helper.
//
// Builds its editor from `buildExtensions('document', ...)` in `./extensions`,
// the same function `<MarkdownEditor variant='document'>` mounts in
// `./react/editor.tsx`. It is imported, not copied: the React editor and the CI
// fixture suite exercise one pipeline, so the fixture guarantee cannot drift
// from what the app ships.
//
// Used by:
//   - `src/__tests__/roundtrip.test.ts` — real agent-generated fixture suite
//   - `src/__tests__/block-types.test.ts` — per-block-type + edge-case tests
//
// Note: `new Editor()` needs a DOM. Vitest supplies one via `environment:
// 'jsdom'` (see `vitest.config.ts`). Callers outside a browser or jsdom
// environment must set one up first.

import { Editor } from '@tiptap/core'
import { buildExtensions } from './extensions'

function buildEditor(markdown: string): Editor {
	return new Editor({
		extensions: buildExtensions('document', undefined, undefined, undefined),
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
