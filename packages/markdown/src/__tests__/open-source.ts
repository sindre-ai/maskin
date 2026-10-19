// Test helper: open markdown the way the file viewer does (the app's real
// extension setup, the editor's own parser), edit it, and ask what would be
// saved. Not a test file.

import { Editor } from '@tiptap/core'
import { editorMarkdownIt, nodeFeatures, serializeTopLevelBlocks } from '../editor-blocks'
import { buildExtensions } from '../extensions'
import {
	type SaveResult,
	type SourceSession,
	buildSave,
	createSourceSession,
	findReadOnlyCause,
} from '../source-blocks'

export interface OpenedSource {
	editor: Editor
	/** Why it must open read-only, or null when it is editable. */
	cause: ReturnType<typeof findReadOnlyCause>
	session: SourceSession | null
	save(): SaveResult
	/** Replace the first occurrence of a piece of text, as a person typing would. */
	replace(from: string, to: string): void
	destroy(): void
}

export function openSource(original: string): OpenedSource {
	const editor = new Editor({
		extensions: buildExtensions('document', undefined, undefined, undefined),
		content: original,
	})
	const md = editorMarkdownIt(editor)
	const cause = findReadOnlyCause(md, original, editor.state.doc.childCount)
	const session = cause ? null : createSourceSession(md, original, serializeTopLevelBlocks(editor))

	return {
		editor,
		cause,
		session,
		save: () => {
			if (!session) return { text: original, refused: [] }
			return buildSave(session, {
				current: serializeTopLevelBlocks(editor),
				currentFeatures: (index) => nodeFeatures(editor.state.doc.child(index)),
			})
		},
		replace: (from, to) => {
			let done = false
			editor.state.doc.descendants((node, pos) => {
				if (done || !node.isText || !node.text) return
				const at = node.text.indexOf(from)
				if (at < 0) return
				editor.commands.command(({ tr, dispatch }) => {
					tr.insertText(to, pos + at, pos + at + from.length)
					dispatch?.(tr)
					return true
				})
				done = true
			})
			if (!done) throw new Error(`text not found in the document: ${from}`)
		},
		destroy: () => editor.destroy(),
	}
}

/** Lines that differ between two texts, by position. */
export function changedLines(before: string, after: string): string[] {
	const a = before.split('\n')
	const b = after.split('\n')
	const out: string[] = []
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i] !== b[i]) out.push(`${a[i] ?? '(none)'} -> ${b[i] ?? '(none)'}`)
	}
	return out
}
