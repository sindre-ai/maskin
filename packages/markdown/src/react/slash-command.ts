// Slash-command menu for `<MarkdownEditor variant='document'>`, built on
// `@tiptap/suggestion` (tech spec §6). This module owns the Tiptap side: the
// eight block items, the substring filter, the trigger rules and the
// suggestion lifecycle. It renders nothing. The menu itself (cmdk in a Radix
// popover) is injected through `createView`, so this package keeps its
// zero-UI-dependency shape and apps/web supplies the look.

import { type Editor, Extension, type Range } from '@tiptap/core'
import { type EditorState, PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion'

/** Language option for the Code block second step. `null` language = plain text. */
export interface SlashCodeLanguage {
	id: string
	label: string
	language: string | null
}

export const SLASH_CODE_LANGUAGES: readonly SlashCodeLanguage[] = [
	{ id: 'plain', label: 'Plain text', language: null },
	{ id: 'javascript', label: 'JavaScript', language: 'javascript' },
	{ id: 'typescript', label: 'TypeScript', language: 'typescript' },
	{ id: 'python', label: 'Python', language: 'python' },
	{ id: 'json', label: 'JSON', language: 'json' },
	{ id: 'bash', label: 'Bash', language: 'bash' },
	{ id: 'sql', label: 'SQL', language: 'sql' },
	{ id: 'html', label: 'HTML', language: 'html' },
	{ id: 'css', label: 'CSS', language: 'css' },
	{ id: 'yaml', label: 'YAML', language: 'yaml' },
	{ id: 'markdown', label: 'Markdown', language: 'markdown' },
	{ id: 'go', label: 'Go', language: 'go' },
	{ id: 'rust', label: 'Rust', language: 'rust' },
	{ id: 'c', label: 'C', language: 'c' },
]

export interface SlashItemRunOptions {
	/** Code block only. Omitted or null means plain text. */
	language?: string | null
}

export interface SlashItem {
	/** Stable id, sent as `command_id` on editor_slash_command_used. Never rename. */
	id: string
	title: string
	/** One line under the title. */
	description: string
	/** Extra names the filter matches, so old names and muscle memory still land. */
	aliases: readonly string[]
	/**
	 * ProseMirror node the item inserts. Items whose node the editor lacks are hidden.
	 * Omit it for an item that inserts no node (a host action such as attaching a file).
	 */
	node?: string
	/** True when picking the item opens a second step (the language picker). */
	needsLanguage?: boolean
	run: (editor: Editor, range: Range, options?: SlashItemRunOptions) => void
}

// `deleteRange` first so the typed "/query" never survives into the block.
export const SLASH_ITEMS: readonly SlashItem[] = [
	{
		id: 'heading',
		title: 'Heading',
		description: 'Section title',
		// Level 2: the object title is already the page's level 1.
		aliases: ['h1', 'h2', 'heading 1', 'heading 2', 'title', 'section'],
		node: 'heading',
		run: (editor, range) =>
			editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
	},
	{
		id: 'subheading',
		title: 'Subheading',
		description: 'Smaller title',
		aliases: ['h3', 'heading 3', 'subtitle'],
		node: 'heading',
		run: (editor, range) =>
			editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
	},
	{
		id: 'bulleted-list',
		title: 'Bulleted list',
		description: 'Simple list',
		aliases: ['bullet', 'bullet list', 'unordered', 'ul'],
		node: 'bulletList',
		run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
	},
	{
		id: 'numbered-list',
		title: 'Numbered list',
		description: 'Ordered steps',
		aliases: ['numbered', 'ordered', 'ordered list', 'number', 'ol'],
		node: 'orderedList',
		run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
	},
	{
		id: 'checklist',
		title: 'Checklist',
		description: 'Tick items off',
		aliases: ['task', 'task list', 'todo', 'checkbox', 'check'],
		node: 'taskList',
		run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
	},
	{
		id: 'quote',
		title: 'Quote',
		description: 'Call out a passage',
		aliases: ['blockquote', 'callout'],
		node: 'blockquote',
		run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
	},
	{
		id: 'code-block',
		title: 'Code block',
		description: 'Monospace, keeps spacing',
		aliases: ['code', 'codeblock', 'snippet', 'pre'],
		node: 'codeBlock',
		needsLanguage: true,
		run: (editor, range, options) => {
			const language = options?.language ?? null
			editor
				.chain()
				.focus()
				.deleteRange(range)
				.setCodeBlock(language ? { language } : undefined)
				.run()
		},
	},
	{
		id: 'divider',
		title: 'Divider',
		description: 'Horizontal rule',
		aliases: ['hr', 'horizontal rule', 'rule', 'line', 'separator'],
		node: 'horizontalRule',
		run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
	},
]

const CHAT_BLOCK_IDS = ['code-block', 'quote', 'bulleted-list', 'numbered-list'] as const

export const ATTACH_FILE_ITEM_ID = 'attach-file'

/**
 * The menu for a chat message box: the document blocks a message can hold, plus
 * a row that opens the host's file picker.
 */
export function buildChatSlashItems(attachFile: () => void): SlashItem[] {
	const blocks = CHAT_BLOCK_IDS.flatMap((id) => {
		const item = SLASH_ITEMS.find((i) => i.id === id)
		// A message has no language step: picking Code block switches the box straight to one.
		return item ? [{ ...item, needsLanguage: false }] : []
	})
	return [
		...blocks,
		{
			id: ATTACH_FILE_ITEM_ID,
			title: 'Attach a file',
			description: 'Add a file to this message',
			aliases: ['file', 'upload', 'attachment', 'image', 'photo'],
			run: (editor, range) => {
				editor.chain().focus().deleteRange(range).run()
				attachFile()
			},
		},
	]
}

/**
 * Substring match, case-insensitive, on title and aliases. No fuzzy matching:
 * with eight items it only adds surprises. An empty query returns everything.
 */
export function filterSlashItems(
	query: string,
	items: readonly SlashItem[] = SLASH_ITEMS,
): SlashItem[] {
	const q = query.trim().toLowerCase()
	if (q === '') return [...items]
	return items.filter(
		(item) =>
			item.title.toLowerCase().includes(q) || item.aliases.some((alias) => alias.includes(q)),
	)
}

/** The items this editor can actually insert (a disallowed node drops its rows). */
export function availableSlashItems(
	editor: Editor,
	items: readonly SlashItem[] = SLASH_ITEMS,
): SlashItem[] {
	return items.filter((item) => item.node === undefined || editor.schema.nodes[item.node])
}

/** What the injected view gets on every suggestion update. */
export interface SlashMenuState {
	editor: Editor
	query: string
	items: SlashItem[]
	/** Caret rectangle for anchoring. Null when the decoration is not on screen. */
	clientRect: (() => DOMRect | null) | null
	/** Run an item and close the menu. */
	select: (item: SlashItem, options?: SlashItemRunOptions) => void
	/** Close the menu and keep the typed text, as Escape does. */
	dismiss: () => void
}

export interface SlashMenuView {
	update: (state: SlashMenuState) => void
	/** Return true when the view consumed the key. */
	onKeyDown: (event: KeyboardEvent) => boolean
	destroy: () => void
}

export interface SlashCommandOptions {
	createView: (state: SlashMenuState) => SlashMenuView
	/** The menu's items. Defaults to the eight document blocks in SLASH_ITEMS. */
	items?: readonly SlashItem[]
	/** Fires once per inserted item, after the command ran. */
	onCommandUsed?: (commandId: string) => void
}

export interface SlashCommandStorage {
	/** The bubble menu reads `editor.storage.suggestion?.active` to stay hidden. */
	active: boolean
	/** Start of a slash the person dismissed; it stays closed until that slash goes. */
	dismissedFrom: number | null
}

const pluginKey = new PluginKey('slashCommand')

function isInsideCode(state: EditorState, from: number): boolean {
	const $from = state.doc.resolve(from)
	return $from.parent.type.spec.code === true || $from.marks().some((m) => m.type.name === 'code')
}

/**
 * Registered under the name `suggestion` on purpose: the floating toolbar
 * checks `editor.storage.suggestion?.active` to stay out of the way.
 */
export const SlashCommand = Extension.create<SlashCommandOptions, SlashCommandStorage>({
	name: 'suggestion',

	addOptions() {
		return {
			createView: () => {
				throw new Error('SlashCommand needs a createView option')
			},
			items: SLASH_ITEMS,
			onCommandUsed: undefined,
		}
	},

	addStorage() {
		return { active: false, dismissedFrom: null }
	},

	onTransaction({ transaction }) {
		if (this.storage.dismissedFrom === null || !transaction.docChanged) return
		const from = transaction.mapping.map(this.storage.dismissedFrom)
		this.storage.dismissedFrom = from
		// The dismissed slash is gone (deleted, or text moved over it): forget it,
		// so a new "/" typed in the same place opens the menu again.
		const doc = this.editor.state.doc
		const stillThere = from < doc.content.size && doc.textBetween(from, from + 1, '\n') === '/'
		if (!stillThere) this.storage.dismissedFrom = null
	},

	addProseMirrorPlugins() {
		const { editor, storage, options } = this
		let view: SlashMenuView | null = null

		const dismiss = (from: number) => {
			storage.dismissedFrom = from
			// An empty transaction re-runs the plugin's `allow` check, which now
			// refuses this slash and so closes the menu.
			editor.view.dispatch(editor.state.tr)
		}

		return [
			Suggestion<SlashItem>({
				editor,
				pluginKey,
				char: '/',
				// Start of a block or after whitespace: mid-word "and/or" must not open it.
				allowedPrefixes: [' ', ' '],
				// So the aliases "task list" and "heading 2" are typeable.
				allowSpaces: true,
				allow: ({ state, range }) => {
					if (range.from === storage.dismissedFrom) return false
					if (isInsideCode(state, range.from)) return false
					const query = state.doc.textBetween(range.from + 1, range.to, '\n')
					// "/ " is a literal slash followed by a space, not a query.
					if (/^\s/.test(query)) return false
					// Once the query has a space and nothing matches, the person is writing.
					if (
						/\s/.test(query) &&
						filterSlashItems(query, availableSlashItems(editor, options.items)).length === 0
					) {
						return false
					}
					return true
				},
				items: ({ query }) => filterSlashItems(query, availableSlashItems(editor, options.items)),
				command: ({ editor: e, range, props }) => props.run(e, range),
				render: () => {
					const stateFor = (props: SuggestionProps<SlashItem>): SlashMenuState => ({
						editor,
						query: props.query,
						items: props.items,
						clientRect: props.clientRect ?? null,
						select: (item, runOptions) => {
							item.run(editor, props.range, runOptions)
							options.onCommandUsed?.(item.id)
						},
						dismiss: () => dismiss(props.range.from),
					})
					return {
						onStart: (props) => {
							storage.active = true
							view = options.createView(stateFor(props))
						},
						onUpdate: (props) => view?.update(stateFor(props)),
						onKeyDown: ({ event }) => view?.onKeyDown(event) ?? false,
						onExit: () => {
							storage.active = false
							view?.destroy()
							view = null
						},
					}
				},
			}),
		]
	},
})
