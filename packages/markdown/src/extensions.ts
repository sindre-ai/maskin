// The one Tiptap extension setup. `<MarkdownEditor>` (react/editor.tsx) mounts
// it and the headless round-trip helper (roundtrip.ts, used by the fixture
// suite) imports the same builder, so the CI fixtures run against the editor
// the app really ships and the two cannot drift (CTO rider 1).

import { Extension, Node, mergeAttributes } from '@tiptap/core'
import type { Extensions } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { Markdown } from 'tiptap-markdown'
import { MarkdownTaskList } from './task-list'

// One lowlight instance across every editor mount — building the language
// registry is not free and it never changes at runtime.
const lowlight = createLowlight(common)

export type EditorVariant = 'document' | 'comment' | 'notification'

export type EditorDisallowedNode = 'heading' | 'table' | 'taskList' | 'codeBlock'

// Empty-state hint per variant. The document variant points at the slash menu;
// the comment and notification variants have no slash items yet.
const DEFAULT_PLACEHOLDER_BY_VARIANT: Record<EditorVariant, string> = {
	document: 'Add a description. Type / for blocks.',
	comment: 'Write, or press / for commands',
	notification: 'Write, or press / for commands',
}

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

// tiptap-markdown writes a "<" in text as &lt; and a ">" as &gt;. A placeholder
// such as <owner> in prose would come back as &lt;owner&gt;, which reads the
// same in the app but not in the raw file. Write a backslash instead (\<owner>),
// which every markdown reader shows as the same words. The sentinel stands in for
// "<" while the serializer escapes everything else, then becomes the backslash pair.
// tiptap-markdown reads a node's markdown spec from its storage when it
// serialises, so this swaps the text node's serializer once the editor exists.
const ANGLE = '\uE000'

const KeepAngleBrackets = Extension.create({
	name: 'keepAngleBrackets',
	onBeforeCreate() {
		const text = this.editor.extensionManager.extensions.find((e) => e.name === 'text')
		if (!text) return
		text.storage = {
			...text.storage,
			markdown: {
				serialize(state: { text(text: string): void; out: string }, node: { text?: string }) {
					state.text((node.text ?? '').replace(/<(?=[A-Za-z/!?])/g, ANGLE))
					state.out = state.out.split(ANGLE).join('\\<')
				},
			},
		}
	},
})

export function buildExtensions(
	variant: EditorVariant,
	disallowedNodes: EditorDisallowedNode[] | undefined,
	placeholder: string | undefined,
	extra: Extensions | undefined,
	shortcutExtension?: Extension,
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
		KeepAngleBrackets,
		Link.configure({
			openOnClick: false,
			autolink: true,
			HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
		}),
		Placeholder.configure({
			placeholder: placeholder ?? DEFAULT_PLACEHOLDER_BY_VARIANT[variant],
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
		extensions.push(MarkdownTaskList, TaskItem.configure({ nested: true }))
	}

	// Shortcut extension is variant-agnostic; the individual key handlers
	// return the command result, so a shortcut whose command is disabled
	// (e.g. heading on comment variant) is a no-op and doesn't emit.
	if (shortcutExtension) extensions.push(shortcutExtension)

	if (extra) extensions.push(...extra)

	return extensions
}
