// The one Tiptap extension setup. `<MarkdownEditor>` (react/editor.tsx) mounts
// it and the headless round-trip helper (roundtrip.ts, used by the fixture
// suite) imports the same builder, so the CI fixtures run against the editor
// the app really ships and the two cannot drift (CTO rider 1).

import { Node, mergeAttributes } from '@tiptap/core'
import type { Extensions } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { Markdown } from 'tiptap-markdown'

// One lowlight instance across every editor mount — building the language
// registry is not free and it never changes at runtime.
const lowlight = createLowlight(common)

export type EditorVariant = 'document' | 'comment' | 'notification'

export type EditorDisallowedNode = 'heading' | 'table' | 'taskList' | 'codeBlock'

// The editor accepts every ATX level so an existing H4 to H6 (or an H1) is
// kept. The slash menu is the place that limits what people can insert.
const HEADING_LEVELS_BY_VARIANT: Record<EditorVariant, Array<1 | 2 | 3 | 4 | 5 | 6>> = {
	document: [1, 2, 3, 4, 5, 6],
	comment: [],
	notification: [],
}

/**
 * Inline image node. tiptap-markdown already serialises a node named "image"
 * as ![alt](src "title"), so this only has to hold the attributes; it keeps an
 * image alone on a line and an image inside a paragraph through an edit.
 */
export const InlineImage = Node.create({
	name: 'image',
	inline: true,
	group: 'inline',
	draggable: true,
	addAttributes() {
		return {
			src: { default: null },
			alt: { default: null },
			title: { default: null },
		}
	},
	parseHTML() {
		return [{ tag: 'img[src]' }]
	},
	renderHTML({ HTMLAttributes }) {
		return ['img', mergeAttributes(HTMLAttributes)]
	},
})

export function buildExtensions(
	variant: EditorVariant,
	disallowedNodes: EditorDisallowedNode[] | undefined,
	placeholder: string | undefined,
	extra: Extensions | undefined,
): Extensions {
	const disallowed = new Set<EditorDisallowedNode>(disallowedNodes ?? [])
	const headingLevels = HEADING_LEVELS_BY_VARIANT[variant]
	const includeHeading = headingLevels.length > 0 && !disallowed.has('heading')
	const includeTable = variant === 'document' && !disallowed.has('table')
	const includeTaskList = variant !== 'notification' && !disallowed.has('taskList')
	const includeCodeBlock = !disallowed.has('codeBlock')

	const extensions: Extensions = [
		// StarterKit ships Doc, Paragraph, Text, Bold, Italic, Strike, BulletList,
		// OrderedList, ListItem, Blockquote, HorizontalRule, Code (inline),
		// HardBreak, History, Dropcursor, Gapcursor. CodeBlock is replaced by
		// CodeBlockLowlight below; Heading is variant-gated.
		StarterKit.configure({
			codeBlock: false,
			heading: includeHeading ? { levels: headingLevels } : false,
		}),
		InlineImage,
		Link.configure({
			openOnClick: false,
			autolink: true,
			HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
		}),
		Placeholder.configure({
			placeholder: placeholder ?? 'Write, or press / for commands',
		}),
		// Round-trips markdown to a ProseMirror doc on load and back to markdown
		// on save. Fenced code, GFM tables, task lists, strike all flow through.
		// breaks: true matches the read view (remark-breaks), which shows a single
		// line break as a line break.
		Markdown.configure({
			html: false,
			tightLists: true,
			bulletListMarker: '-',
			linkify: false,
			breaks: true,
			transformPastedText: true,
			transformCopiedText: true,
		}),
	]

	if (includeCodeBlock) {
		extensions.push(CodeBlockLowlight.configure({ lowlight }))
	}

	if (includeTable) {
		extensions.push(Table.configure({ resizable: false }), TableRow, TableHeader, TableCell)
	}

	if (includeTaskList) {
		extensions.push(TaskList, TaskItem.configure({ nested: true }))
	}

	if (extra) extensions.push(...extra)

	return extensions
}
