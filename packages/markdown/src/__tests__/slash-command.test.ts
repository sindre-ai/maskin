import { Editor } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	SLASH_ITEMS,
	SlashCommand,
	type SlashMenuState,
	type SlashMenuView,
	availableSlashItems,
	filterSlashItems,
} from '../react/slash-command'

const lowlight = createLowlight(common)

interface Harness {
	editor: Editor
	states: SlashMenuState[]
	destroyed: ReturnType<typeof vi.fn>
	onCommandUsed: ReturnType<typeof vi.fn>
}

function mount(content = ''): Harness {
	const states: SlashMenuState[] = []
	const destroyed = vi.fn()
	const onCommandUsed = vi.fn()
	const editor = new Editor({
		content,
		extensions: [
			StarterKit.configure({ codeBlock: false, heading: { levels: [1, 2, 3] } }),
			CodeBlockLowlight.configure({ lowlight }),
			TaskList,
			TaskItem,
			SlashCommand.configure({
				onCommandUsed,
				createView: (state): SlashMenuView => {
					states.push(state)
					return {
						update: (next) => states.push(next),
						onKeyDown: () => false,
						destroy: destroyed,
					}
				},
			}),
		],
	})
	return { editor, states, destroyed, onCommandUsed }
}

/**
 * The suggestion plugin awaits the item list before it opens or updates the
 * menu, so the view only sees a keystroke one tick after the transaction.
 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Types a string at the end of the document, one character at a time. */
async function type(editor: Editor, text: string) {
	for (const char of text) {
		editor.commands.insertContent(char)
		await settle()
	}
}

describe('SLASH_ITEMS', () => {
	it('lists exactly the eight document blocks in order, with their descriptions', () => {
		expect(SLASH_ITEMS.map((i) => [i.title, i.description])).toEqual([
			['Heading', 'Section title'],
			['Subheading', 'Smaller title'],
			['Bulleted list', 'Simple list'],
			['Numbered list', 'Ordered steps'],
			['Checklist', 'Tick items off'],
			['Quote', 'Call out a passage'],
			['Code block', 'Monospace, keeps spacing'],
			['Divider', 'Horizontal rule'],
		])
	})

	it('has one stable id per row and no table, link or heading 1 item', () => {
		const ids = SLASH_ITEMS.map((i) => i.id)
		expect(new Set(ids).size).toBe(8)
		expect(ids).toEqual([
			'heading',
			'subheading',
			'bulleted-list',
			'numbered-list',
			'checklist',
			'quote',
			'code-block',
			'divider',
		])
		expect(SLASH_ITEMS.some((i) => /table|link|heading 1/i.test(i.title))).toBe(false)
	})
})

describe('filterSlashItems', () => {
	it('returns every item for an empty query', () => {
		expect(filterSlashItems('')).toHaveLength(8)
		expect(filterSlashItems('   ')).toHaveLength(8)
	})

	it('matches the title as a case-insensitive substring', () => {
		expect(filterSlashItems('QUO').map((i) => i.id)).toEqual(['quote'])
		expect(filterSlashItems('list').map((i) => i.id)).toEqual([
			'bulleted-list',
			'numbered-list',
			'checklist',
		])
	})

	it('matches the old names so muscle memory still lands', () => {
		expect(filterSlashItems('task list').map((i) => i.id)).toEqual(['checklist'])
		expect(filterSlashItems('blockquote').map((i) => i.id)).toEqual(['quote'])
		expect(filterSlashItems('bullet').map((i) => i.id)).toEqual(['bulleted-list'])
		expect(filterSlashItems('h1').map((i) => i.id)).toEqual(['heading'])
	})

	it('does not fuzzy match', () => {
		expect(filterSlashItems('hdng')).toEqual([])
		expect(filterSlashItems('cdblk')).toEqual([])
	})

	it('does not match on the description', () => {
		expect(filterSlashItems('monospace')).toEqual([])
	})
})

describe('SlashCommand extension', () => {
	let harness: Harness | undefined
	afterEach(() => {
		harness?.editor.destroy()
		harness = undefined
	})

	it('opens on / at the start of a block and reports itself active', async () => {
		harness = mount()
		await type(harness.editor, '/')
		expect(harness.states.length).toBeGreaterThan(0)
		expect(harness.states[0]?.items).toHaveLength(8)
		expect(harness.editor.storage.suggestion.active).toBe(true)
	})

	it('opens on / after whitespace', async () => {
		harness = mount()
		await type(harness.editor, 'hello /')
		expect(harness.states.length).toBeGreaterThan(0)
	})

	it('does not open on / in the middle of a word', async () => {
		harness = mount()
		await type(harness.editor, 'and/')
		expect(harness.states).toHaveLength(0)
		expect(harness.editor.storage.suggestion.active).toBe(false)
	})

	it('does not open inside a code block', async () => {
		harness = mount('<pre><code></code></pre>')
		harness.editor.commands.focus('end')
		await type(harness.editor, '/')
		expect(harness.states).toHaveLength(0)
	})

	it('filters as the query grows and closes when a spaced query matches nothing', async () => {
		harness = mount()
		await type(harness.editor, '/head')
		expect(harness.states.at(-1)?.items.map((i) => i.id)).toEqual(['heading', 'subheading'])
		await type(harness.editor, 'zzz yyy')
		expect(harness.editor.storage.suggestion.active).toBe(false)
		expect(harness.destroyed).toHaveBeenCalled()
	})

	it('stays closed after dismiss until the slash is typed again', async () => {
		harness = mount()
		await type(harness.editor, '/')
		harness.states.at(-1)?.dismiss()
		await settle()
		expect(harness.editor.storage.suggestion.active).toBe(false)
		// The slash is still in the document.
		expect(harness.editor.getText()).toBe('/')
		await type(harness.editor, 'h')
		expect(harness.editor.storage.suggestion.active).toBe(false)
	})

	it('inserts Heading as a level 2 heading and removes the typed query', async () => {
		harness = mount()
		await type(harness.editor, '/head')
		const heading = harness.states.at(-1)?.items.find((i) => i.id === 'heading')
		expect(heading).toBeDefined()
		if (heading) harness.states.at(-1)?.select(heading)
		const first = harness.editor.getJSON().content?.[0]
		expect(first?.type).toBe('heading')
		expect(first?.attrs?.level).toBe(2)
		expect(harness.editor.getText()).toBe('')
		expect(harness.onCommandUsed).toHaveBeenCalledWith('heading')
	})

	it('inserts Subheading as a level 3 heading', async () => {
		harness = mount()
		await type(harness.editor, '/')
		const item = SLASH_ITEMS.find((i) => i.id === 'subheading')
		if (item) harness.states.at(-1)?.select(item)
		expect(harness.editor.getJSON().content?.[0]?.attrs?.level).toBe(3)
	})

	it('inserts a bulleted list', async () => {
		harness = mount()
		await type(harness.editor, '/')
		const item = SLASH_ITEMS.find((i) => i.id === 'bulleted-list')
		if (item) harness.states.at(-1)?.select(item)
		expect(harness.editor.getJSON().content?.[0]?.type).toBe('bulletList')
	})

	it('inserts a code block, plain text by default and with a language when given one', async () => {
		harness = mount()
		await type(harness.editor, '/')
		const item = SLASH_ITEMS.find((i) => i.id === 'code-block')
		if (item) harness.states.at(-1)?.select(item)
		const plain = harness.editor.getJSON().content?.[0]
		expect(plain?.type).toBe('codeBlock')
		expect(plain?.attrs?.language ?? null).toBeNull()

		harness.editor.commands.setContent('')
		await type(harness.editor, '/')
		if (item) harness.states.at(-1)?.select(item, { language: 'python' })
		expect(harness.editor.getJSON().content?.[0]?.attrs?.language).toBe('python')
	})

	it('inserts a divider', async () => {
		harness = mount()
		await type(harness.editor, '/')
		const item = SLASH_ITEMS.find((i) => i.id === 'divider')
		if (item) harness.states.at(-1)?.select(item)
		expect(harness.editor.getJSON().content?.some((n) => n.type === 'horizontalRule')).toBe(true)
	})
})

describe('availableSlashItems', () => {
	it('drops the rows whose node the editor does not have', () => {
		const editor = new Editor({
			extensions: [StarterKit.configure({ heading: false, codeBlock: false })],
		})
		const ids = availableSlashItems(editor).map((i) => i.id)
		expect(ids).not.toContain('heading')
		expect(ids).not.toContain('subheading')
		expect(ids).not.toContain('checklist')
		expect(ids).not.toContain('code-block')
		expect(ids).toContain('divider')
		editor.destroy()
	})
})
