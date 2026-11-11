// The chat message box: the notification variant of the shared editor with the few things a
// message box needs on top. `@` tags are chips inside the sentence, Enter sends, a table pasted
// from a page or a sheet stays a markdown table, and text is written out as typed (no escaping),
// so a secret the person types reaches the send check the way they typed it.

import { Extension, Node, mergeAttributes } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { MarkdownEditor } from './editor'
import {
	SlashCommand,
	type SlashMenuState,
	type SlashMenuView,
	buildChatSlashItems,
} from './slash-command'

export interface ComposerTag {
	id: string
	label: string
}

export interface ComposerValue {
	/** The message as markdown. A tag is written as "@label". */
	markdown: string
	/** The ids of the tags in the box, in order, once each. */
	mentionIds: string[]
}

export interface ComposerTrigger {
	query: string
}

/** The formats the format row offers. Each one is the command its shortcut runs. */
export type ComposerFormat =
	| 'bold'
	| 'italic'
	| 'strike'
	| 'link'
	| 'bulletList'
	| 'orderedList'
	| 'blockquote'
	| 'code'
	| 'codeBlock'

export interface MarkdownComposerHandle {
	focus(): void
	/** Toggles a format at the caret or on the selection, the way its shortcut does. */
	toggleFormat(format: Exclude<ComposerFormat, 'link'>): void
	/** Makes the selection a link (or inserts the address as a link when nothing is selected). */
	setLink(href: string): void
	removeLink(): void
	/** The address of the link at the caret, or null. */
	linkHref(): string | null
	/** Replaces the document. Each "@label" of a known tag becomes a chip. Reports through onChange. */
	setMarkdown(markdown: string, tags: ComposerTag[]): void
	/** Types an "@" at the caret (or the end), which opens the picker. */
	startMention(): void
	/** Swaps the open "@query" for a chip and a space; with no "@query" it goes at the caret. */
	insertMention(tag: ComposerTag): void
}

export interface ComposerSlashMenu {
	/** Paints the menu. apps/web supplies it, so this package keeps no UI dependency. */
	createView: (state: SlashMenuState) => SlashMenuView
	/** Opens the file picker, for the menu's "Attach a file" row. */
	attachFile: () => void
	onCommandUsed?: (commandId: string) => void
}

export interface MarkdownComposerProps {
	/** The markdown the box opens with. Read once: later changes go through the handle. */
	value: string
	/** The tags the opening text stands for. Read once. */
	tags: ComposerTag[]
	placeholder: string
	ariaLabel?: string
	ariaDescribedBy?: string
	readOnly?: boolean
	autoFocus?: boolean
	className?: string
	/** Typing "/" opens a short menu (code block, quote, lists, attach a file). Read once. */
	slashMenu?: ComposerSlashMenu
	/** The class a chip is drawn with. */
	chipClass: (id: string) => string
	/** Finds the "@query" at the end of the text before the caret, or null. */
	detectTrigger: (text: string, caret: number) => { atPos: number; query: string } | null
	onChange: (value: ComposerValue) => void
	/** The formats in force at the caret or selection, for the pressed state of the format row. */
	onActiveFormatsChange?: (active: ComposerFormat[]) => void
	onTriggerChange: (trigger: ComposerTrigger | null) => void
	/**
	 * Every key goes here first. Return true when it was used (the picker, Enter to send). Enter
	 * inside a list or a code block keeps its own meaning and only comes here with Cmd or Ctrl, or
	 * while the picker is open.
	 */
	onKeyDown: (event: KeyboardEvent) => boolean
}

const MENTION_NODE = 'composerMention'

// The format name in the editor, for the pressed state.
const ACTIVE_NAMES: [ComposerFormat, string][] = [
	['bold', 'bold'],
	['italic', 'italic'],
	['strike', 'strike'],
	['link', 'link'],
	['bulletList', 'bulletList'],
	['orderedList', 'orderedList'],
	['blockquote', 'blockquote'],
	['code', 'code'],
	['codeBlock', 'codeBlock'],
]

function createMentionNode(chipClass: (id: string) => string) {
	return Node.create({
		name: MENTION_NODE,
		group: 'inline',
		inline: true,
		atom: true,
		selectable: false,
		addAttributes() {
			return { id: { default: '' }, label: { default: '' } }
		},
		parseHTML() {
			return [{ tag: 'span[data-composer-tag]' }]
		},
		renderHTML({ node, HTMLAttributes }) {
			return [
				'span',
				mergeAttributes(HTMLAttributes, {
					'data-composer-tag': node.attrs.id,
					class: chipClass(node.attrs.id),
				}),
				`@${node.attrs.label}`,
			]
		},
		addStorage() {
			return {
				markdown: {
					serialize(state: { write(text: string): void }, node: { attrs: { label: string } }) {
						state.write(`@${node.attrs.label}`)
					},
					parse: {},
				},
			}
		},
	})
}

// "<" is written as a backslash pair, as in the other editors, so a placeholder such as <owner>
// is not taken for markup. Everything else is written as typed.
const ANGLE = ''

interface SiblingNode {
	type: unknown
}

interface ParentNode {
	childCount: number
	child(index: number): SiblingNode
}

interface SerializerState {
	text(text: string, escaped?: boolean): void
	out: string
	closed: { type: { name: string }; content: { size: number } } | null
	flushClose(size?: number): void
	renderInline(node: unknown): void
	closeBlock(node: unknown): void
}

function plainSerializers(editor: Editor) {
	const find = (name: string) => editor.extensionManager.extensions.find((e) => e.name === name)
	const text = find('text')
	if (text) {
		text.storage = {
			...text.storage,
			markdown: {
				serialize(state: SerializerState, node: { text?: string }) {
					state.text((node.text ?? '').replace(/<(?=[A-Za-z/!?])/g, ANGLE), false)
					state.out = state.out.split(ANGLE).join('\\<')
				},
			},
		}
	}
	// Shift+Enter starts a new paragraph (so a list, quote or code block can start on the new
	// line). Two filled paragraphs in a row are written one line apart, as a textarea would have
	// sent them, not with a blank line between.
	const paragraph = find('paragraph')
	if (paragraph) {
		paragraph.storage = {
			...paragraph.storage,
			markdown: {
				serialize(state: SerializerState, node: { content: { size: number } }) {
					const previous = state.closed
					if (
						previous?.type.name === 'paragraph' &&
						previous.content.size > 0 &&
						node.content.size > 0
					) {
						state.flushClose(1)
					}
					state.renderInline(node)
					state.closeBlock(node)
				},
			},
		}
	}
	// A new line made another way (pasted HTML with a line break) is a plain new line too, not a
	// backslash at the end of the line.
	const hardBreak = find('hardBreak')
	if (hardBreak) {
		hardBreak.storage = {
			...hardBreak.storage,
			markdown: {
				serialize(state: SerializerState, node: SiblingNode, parent: ParentNode, index: number) {
					for (let i = index + 1; i < parent.childCount; i++) {
						if (parent.child(i).type !== node.type) {
							state.text('\n', false)
							return
						}
					}
				},
			},
		}
	}
}

function inListOrCode(state: EditorState): boolean {
	const { $from } = state.selection
	for (let depth = $from.depth; depth > 0; depth--) {
		const name = $from.node(depth).type.name
		if (name === 'codeBlock' || name === 'listItem') return true
	}
	return false
}

/**
 * A table copied from a page or a sheet reaches the box with a body-only first row (a sheet has
 * no header cells), header cells in the body, or cells with several paragraphs. A markdown table
 * needs a header row of plain one-paragraph cells and no header cells below it, so the pasted
 * HTML is put in that shape before the editor reads it.
 */
export function shapeTablesForMarkdown(html: string): string {
	if (typeof DOMParser === 'undefined' || !html.includes('<table')) return html
	const doc = new DOMParser().parseFromString(html, 'text/html')
	for (const table of Array.from(doc.querySelectorAll('table'))) {
		const rows = Array.from(table.querySelectorAll('tr'))
		rows.forEach((row, rowIndex) => {
			for (const cell of Array.from(row.children)) {
				if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue
				const next = doc.createElement(rowIndex === 0 ? 'th' : 'td')
				// One paragraph per cell: block wrappers and line breaks become spaces.
				const flat = doc.createElement('div')
				flat.innerHTML = cell.innerHTML.replace(/<\/(?:p|div|li)>|<br\s*\/?>/gi, ' ')
				next.textContent = (flat.textContent ?? '').replace(/\s+/g, ' ').trim()
				cell.replaceWith(next)
			}
		})
	}
	return doc.body.innerHTML
}

export interface Handlers {
	props: MarkdownComposerProps
	editor: Editor | null
}

function mentionIdsOf(editor: Editor): string[] {
	const ids: string[] = []
	editor.state.doc.descendants((node) => {
		if (node.type.name === MENTION_NODE && !ids.includes(node.attrs.id)) ids.push(node.attrs.id)
	})
	return ids
}

function triggerOf(editor: Editor, props: MarkdownComposerProps) {
	const { selection } = editor.state
	if (!selection.empty || !editor.isEditable) return null
	const { $from } = selection
	if ($from.parent.type.name === 'codeBlock' || editor.isActive('code')) return null
	// One character per leaf (a chip, a line break) so an offset in the text is an offset in the block.
	const before = $from.parent.textBetween(0, $from.parentOffset, undefined, ' ')
	const match = props.detectTrigger(before, before.length)
	if (!match) return null
	return { query: match.query, from: $from.start() + match.atPos, to: $from.pos }
}

/** Turns each "@label" of a known tag in the text into a chip. Longer labels first. */
function chipsInPlace(editor: Editor, tags: ComposerTag[]) {
	const ordered = [...tags].sort((a, b) => b.label.length - a.label.length)
	const claimed = new Set<string>()
	const found: { from: number; to: number; tag: ComposerTag }[] = []
	const word = /[\w-]/
	editor.state.doc.descendants((node, pos) => {
		if (!node.isText || node.marks.some((m) => m.type.name === 'code')) return
		const text = node.text ?? ''
		for (const tag of ordered) {
			if (claimed.has(tag.id)) continue
			const needle = `@${tag.label}`
			let from = 0
			while (from <= text.length) {
				const at = text.indexOf(needle, from)
				if (at === -1) break
				const end = at + needle.length
				const busy = found.some((f) => pos + at < f.to && pos + end > f.from)
				if (!busy && !word.test(text[at - 1] ?? '') && !word.test(text[end] ?? '')) {
					found.push({ from: pos + at, to: pos + end, tag })
					claimed.add(tag.id)
					break
				}
				from = at + 1
			}
		}
	})
	const mention = editor.schema.nodes[MENTION_NODE]
	if (found.length === 0 || !mention) return
	const tr = editor.state.tr
	for (const f of found.sort((a, b) => b.from - a.from)) {
		tr.replaceWith(f.from, f.to, mention.create({ id: f.tag.id, label: f.tag.label }))
	}
	editor.view.dispatch(tr)
}

/**
 * The extensions the message box adds to the notification variant, and the two reports that tell
 * the host what the box holds. Split from the component so the headless tests build the same
 * extensions the app mounts. The host's props are read through `handlers`, so the list never changes.
 */
export function createComposerExtensions(handlers: { current: Handlers }) {
	let triggerOpen = false
	const report = (editor: Editor) => {
		handlers.current.props.onChange({
			markdown: editor.storage.markdown.getMarkdown() as string,
			mentionIds: mentionIdsOf(editor),
		})
	}
	const reportTrigger = (editor: Editor) => {
		const trigger = triggerOf(editor, handlers.current.props)
		triggerOpen = trigger !== null
		handlers.current.props.onTriggerChange(trigger ? { query: trigger.query } : null)
	}
	let lastActive = ''
	const reportActive = (editor: Editor) => {
		const active = ACTIVE_NAMES.filter(([, name]) => editor.isActive(name)).map(
			([format]) => format,
		)
		const key = active.join(',')
		if (key === lastActive) return
		lastActive = key
		handlers.current.props.onActiveFormatsChange?.(active)
	}
	const slashMenu = handlers.current.props.slashMenu
	const extensions = [
		// Tiptap runs the plugins of later extensions first, so the menu is lifted above the box's
		// own key handler: a key the menu uses never reaches the send rule. A key it does not use
		// (Enter with no row to pick) still does.
		...(slashMenu
			? [
					SlashCommand.extend({ priority: 200 }).configure({
						createView: slashMenu.createView,
						items: buildChatSlashItems(() => handlers.current.props.slashMenu?.attachFile()),
						onCommandUsed: (id) => handlers.current.props.slashMenu?.onCommandUsed?.(id),
					}),
				]
			: []),
		createMentionNode((id) => handlers.current.props.chipClass(id)),
		Extension.create({
			name: 'composerBehaviour',
			onBeforeCreate() {
				plainSerializers(this.editor)
			},
			onCreate() {
				handlers.current.editor = this.editor
				this.editor.setEditable(!handlers.current.props.readOnly)
				chipsInPlace(this.editor, handlers.current.props.tags)
			},
			onUpdate() {
				report(this.editor)
				reportTrigger(this.editor)
				reportActive(this.editor)
			},
			onSelectionUpdate() {
				reportTrigger(this.editor)
				reportActive(this.editor)
			},
		}),
		Extension.create({
			name: 'composerKeys',
			// Ahead of the editor's own Shift+Enter, which would make a soft line break.
			priority: 1000,
			addProseMirrorPlugins() {
				return [
					new Plugin({
						key: new PluginKey('composerKeys'),
						props: {
							attributes: () => {
								const { ariaDescribedBy } = handlers.current.props
								return {
									'aria-multiline': 'true',
									...(ariaDescribedBy ? { 'aria-describedby': ariaDescribedBy } : {}),
								}
							},
							transformPastedHTML: shapeTablesForMarkdown,
							handleKeyDown: (view, event) => {
								const enter = event.key === 'Enter' && !event.shiftKey
								const withMod = event.metaKey || event.ctrlKey
								if (enter && !withMod && !triggerOpen && inListOrCode(view.state)) return false
								if (handlers.current.props.onKeyDown(event)) return true
								if (event.key === 'Enter' && event.shiftKey && !event.isComposing) {
									if (inListOrCode(view.state)) return false
									return handlers.current.editor?.commands.splitBlock() ?? false
								}
								return false
							},
						},
					}),
				]
			},
		}),
	]
	return { extensions, report, reportTrigger }
}

export const MarkdownComposer = forwardRef<MarkdownComposerHandle, MarkdownComposerProps>(
	function MarkdownComposer(props, ref) {
		const handlers = useRef<Handlers>({ props, editor: null })
		handlers.current.props = props

		// Built once: the editor is rebuilt when the list changes, and the box would lose its text.
		const { extensions, report, reportTrigger } = useMemo(
			() => createComposerExtensions(handlers),
			[],
		)

		const { readOnly } = props
		useEffect(() => {
			const editor = handlers.current.editor
			if (editor && !editor.isDestroyed) editor.setEditable(!readOnly)
		}, [readOnly])

		useImperativeHandle(
			ref,
			() => ({
				focus: () => handlers.current.editor?.commands.focus(),
				toggleFormat: (format) => {
					const editor = handlers.current.editor
					if (!editor || editor.isDestroyed) return
					const chain = editor.chain().focus()
					if (format === 'bold') chain.toggleBold()
					else if (format === 'italic') chain.toggleItalic()
					else if (format === 'strike') chain.toggleStrike()
					else if (format === 'code') chain.toggleCode()
					else if (format === 'codeBlock') chain.toggleCodeBlock()
					else if (format === 'blockquote') chain.toggleBlockquote()
					else if (format === 'bulletList') chain.toggleBulletList()
					else chain.toggleOrderedList()
					chain.run()
				},
				setLink: (href) => {
					const editor = handlers.current.editor
					if (!editor || editor.isDestroyed) return
					const chain = editor.chain().focus()
					if (editor.state.selection.empty && !editor.isActive('link')) {
						chain.insertContent({
							type: 'text',
							text: href,
							marks: [{ type: 'link', attrs: { href } }],
						})
					} else {
						chain.extendMarkRange('link').setLink({ href })
					}
					chain.run()
				},
				removeLink: () => {
					handlers.current.editor?.chain().focus().extendMarkRange('link').unsetLink().run()
				},
				linkHref: () => {
					const editor = handlers.current.editor
					if (!editor || editor.isDestroyed || !editor.isActive('link')) return null
					return (editor.getAttributes('link').href as string | undefined) ?? null
				},
				setMarkdown: (markdown, tags) => {
					const editor = handlers.current.editor
					if (!editor || editor.isDestroyed) return
					editor.commands.setContent(markdown)
					chipsInPlace(editor, tags)
					report(editor)
					reportTrigger(editor)
				},
				startMention: () => {
					const editor = handlers.current.editor
					if (!editor || editor.isDestroyed) return
					const { from } = editor.state.selection
					const before = editor.state.doc.textBetween(Math.max(0, from - 1), from, undefined, ' ')
					const lead = before === '' || /\s/.test(before) ? '@' : ' @'
					editor.chain().focus().insertContent(lead).run()
				},
				insertMention: (tag) => {
					const editor = handlers.current.editor
					if (!editor || editor.isDestroyed) return
					const trigger = triggerOf(editor, handlers.current.props)
					const chip = { type: MENTION_NODE, attrs: { id: tag.id, label: tag.label } }
					const content = [chip, { type: 'text', text: ' ' }]
					const chain = editor.chain().focus()
					if (trigger) chain.insertContentAt({ from: trigger.from, to: trigger.to }, content)
					else chain.insertContent(content)
					chain.run()
				},
			}),
			[report, reportTrigger],
		)

		return (
			<MarkdownEditor
				value={props.value}
				// The box reports on every change through the extension; the blur emit has nothing to add.
				onChange={noop}
				variant="notification"
				surface="chat-composer"
				allowTables
				placeholder={props.placeholder}
				ariaLabel={props.ariaLabel}
				readOnly={props.readOnly}
				autoFocus={props.autoFocus}
				extensions={extensions}
				className={props.className}
			/>
		)
	},
)

function noop() {}
