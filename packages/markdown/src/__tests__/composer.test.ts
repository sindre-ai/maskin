// The chat message box: the notification variant plus tag chips, text written as typed, and
// pasted tables kept as markdown tables.

import { Editor } from '@tiptap/core'
import { DOMParser as ProseMirrorParser } from '@tiptap/pm/model'
import { describe, expect, it, vi } from 'vitest'
import { buildExtensions } from '../extensions'
import {
	type ComposerTag,
	type ComposerValue,
	type Handlers,
	type MarkdownComposerProps,
	createComposerExtensions,
	shapeTablesForMarkdown,
} from '../react/composer'
import type { EmojiMenuState, EmojiMenuView } from '../react/emoji-suggestion'

// Tiptap announces a new editor on the next tick, which is when the box sets its chips.
async function open(
	markdown: string,
	tags: ComposerTag[] = [],
	extra: Partial<MarkdownComposerProps> = {},
) {
	const changes: ComposerValue[] = []
	const triggers: (string | null)[] = []
	const props: MarkdownComposerProps = {
		value: markdown,
		tags,
		placeholder: '',
		chipClass: () => 'chip',
		detectTrigger: (text, caret) => {
			const match = /(?:^|\s)@([\w-]*)$/.exec(text.slice(0, caret))
			if (!match) return null
			return { atPos: match.index + (match[0].startsWith('@') ? 0 : 1), query: match[1] ?? '' }
		},
		onChange: (value) => changes.push(value),
		onTriggerChange: (t) => triggers.push(t ? t.query : null),
		onKeyDown: vi.fn(() => false),
		...extra,
	}
	const handlers: { current: Handlers } = { current: { props, editor: null } }
	const { extensions } = createComposerExtensions(handlers)
	const editor = new Editor({
		extensions: buildExtensions('notification', undefined, undefined, extensions, undefined, true),
		content: markdown,
	})
	const md = () => editor.storage.markdown.getMarkdown() as string
	await new Promise((resolve) => setTimeout(resolve, 0))
	return { editor, md, changes, triggers, props }
}

describe('message box markdown', () => {
	it('keeps the formats a message can carry', async () => {
		const source = [
			'**bold** and *italic* and ~~gone~~ and `code`',
			'> a quote',
			'- one\n- two',
			'1. first\n2. second',
			'```\nconst a = 1\n```',
			'[a link](https://example.com)',
		].join('\n\n')
		const { editor, md } = await open(source)
		const out = md()
		expect(out).toContain('**bold**')
		expect(out).toContain('*italic*')
		expect(out).toContain('~~gone~~')
		expect(out).toContain('`code`')
		expect(out).toContain('> a quote')
		expect(out).toMatch(/^- one\n- two/m)
		expect(out).toMatch(/^1\. first\n2\. second/m)
		expect(out).toContain('```\nconst a = 1\n```')
		expect(out).toContain('[a link](https://example.com)')
		editor.destroy()
	})

	it('writes text as typed: no backslashes before underscores or stars', async () => {
		const { editor, md } = await open('sk_live_abc and 2 * 3 * 4')
		editor.commands.setContent('')
		editor.commands.insertContent({ type: 'text', text: 'key sk_live_abc and 2 * 3 * 4' })
		expect(md()).toBe('key sk_live_abc and 2 * 3 * 4')
		editor.destroy()
	})

	it('writes a new line as a new line, not a backslash', async () => {
		const { editor, md } = await open('')
		editor.commands.insertContent([
			{ type: 'text', text: 'first' },
			{ type: 'hardBreak' },
			{ type: 'text', text: 'second' },
		])
		expect(md()).toBe('first\nsecond')
		editor.destroy()
	})

	it('writes two lines typed one under the other one line apart', async () => {
		const { editor, md } = await open('')
		const paragraph = (text?: string) => ({
			type: 'paragraph',
			content: text ? [{ type: 'text', text }] : [],
		})
		editor.commands.setContent({
			type: 'doc',
			content: [paragraph('first'), paragraph('second'), paragraph(), paragraph('fourth')],
		})
		expect(md()).toBe('first\nsecond\n\nfourth')
		editor.destroy()
	})

	it('keeps an angle-bracket placeholder as words', async () => {
		const { editor, md } = await open('')
		editor.commands.insertContent({ type: 'text', text: 'ping <owner> now' })
		expect(md()).toBe('ping \\<owner> now')
		editor.destroy()
	})
})

describe('message box tags', () => {
	it('turns a known @label into a chip and reports its id', async () => {
		const tags = [
			{ id: 'a1', label: 'Sam' },
			{ id: 'a2', label: 'Sam Lee' },
		]
		const { editor, md, changes } = await open('hi @Sam Lee and @Sam, @Sammy stays text', tags)
		const ids: string[] = []
		editor.state.doc.descendants((n) => {
			if (n.type.name === 'composerMention') ids.push(n.attrs.id)
		})
		expect(ids.sort()).toEqual(['a1', 'a2'])
		// The text reads the same with chips in it.
		expect(md()).toBe('hi @Sam Lee and @Sam, @Sammy stays text')
		expect(changes.at(-1)?.mentionIds.sort()).toEqual(['a1', 'a2'])
		editor.destroy()
	})

	it('reports the open @query while typing', async () => {
		const { editor, triggers } = await open('')
		editor.commands.insertContent('hello @sa')
		expect(triggers.at(-1)).toBe('sa')
		editor.commands.insertContent('m ')
		expect(triggers.at(-1)).toBeNull()
		editor.destroy()
	})
})

// Typing a character the way the browser does: the suggestion plugin awaits its item list.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function typeText(editor: Editor, text: string) {
	for (const char of text) {
		// A text node, not a string: a bare ' ' string is parsed as HTML and the space is dropped.
		editor.commands.insertContent({ type: 'text', text: char })
		await settle()
	}
}

function pressEnter(editor: Editor): boolean {
	const event = new KeyboardEvent('keydown', { key: 'Enter' })
	return editor.view.someProp('handleKeyDown', (f) => f(editor.view, event)) === true
}

describe('message box emoji list', () => {
	function withEmojiView() {
		const states: EmojiMenuState[] = []
		const viewKeys = vi.fn(() => true)
		const createEmojiView = (state: EmojiMenuState): EmojiMenuView => {
			states.push(state)
			return { update: (next) => states.push(next), onKeyDown: viewKeys, destroy: vi.fn() }
		}
		return { states, viewKeys, createEmojiView }
	}

	it('has no emoji list unless the host supplies one', async () => {
		const { editor } = await open('')
		await typeText(editor, ':smi')
		expect(editor.storage.emojiSuggestion).toBeUndefined()
		editor.destroy()
	})

	it('puts the picked emoji in the message as text', async () => {
		const { states, createEmojiView } = withEmojiView()
		const { editor, md } = await open('', [], { createEmojiView })
		await typeText(editor, 'hi :smi')
		const state = states.at(-1)
		const smile = state?.items.find((i) => i.shortcode === 'smile')
		expect(smile).toBeDefined()
		if (!smile) return
		state?.select(smile)
		expect(md()).toBe(`hi ${smile.emoji}`)
		editor.destroy()
	})

	it('gives Enter to the open list instead of sending', async () => {
		const { states, viewKeys, createEmojiView } = withEmojiView()
		const onKeyDown = vi.fn(() => false)
		const { editor } = await open('', [], { createEmojiView, onKeyDown })
		await typeText(editor, ':smi')
		expect(states.length).toBeGreaterThan(0)
		expect(pressEnter(editor)).toBe(true)
		expect(viewKeys).toHaveBeenCalled()
		expect(onKeyDown).not.toHaveBeenCalled()
		editor.destroy()
	})

	it('sends on Enter again once the list is closed', async () => {
		const { states, createEmojiView } = withEmojiView()
		const onKeyDown = vi.fn(() => true)
		const { editor } = await open('', [], { createEmojiView, onKeyDown })
		await typeText(editor, ':smi')
		states.at(-1)?.dismiss()
		await settle()
		expect(pressEnter(editor)).toBe(true)
		expect(onKeyDown).toHaveBeenCalledTimes(1)
		editor.destroy()
	})
})

describe('pasted tables', () => {
	const sheet =
		'<table><tbody><tr><td>Name</td><td>Qty</td></tr><tr><td>Apples</td><td>3</td></tr></tbody></table>'

	it('puts a sheet table (no header cells) in the shape markdown needs', () => {
		const shaped = shapeTablesForMarkdown(sheet)
		expect(shaped).toContain('<th>Name</th>')
		expect(shaped).toContain('<td>Apples</td>')
	})

	it('moves header cells below the first row and flattens multi-line cells', () => {
		const page =
			'<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><th>row</th><td><p>x</p><p>y</p></td></tr></tbody></table>'
		const shaped = shapeTablesForMarkdown(page)
		expect(shaped).toContain('<td>row</td>')
		expect(shaped).toContain('<td>x y</td>')
	})

	it('arrives as a markdown table', async () => {
		const { editor, md } = await open('')
		// What a paste does: the editor's own hook shapes the HTML, then it is read into the document.
		const shaped = editor.view.someProp('transformPastedHTML', (f) => f(sheet)) ?? sheet
		const dom = new DOMParser().parseFromString(shaped, 'text/html').body
		const slice = ProseMirrorParser.fromSchema(editor.schema).parseSlice(dom)
		editor.view.dispatch(editor.state.tr.replaceSelection(slice))
		expect(md().trim()).toBe('| Name | Qty |\n| --- | --- |\n| Apples | 3 |')
		editor.destroy()
	})

	it('leaves HTML without a table alone', () => {
		expect(shapeTablesForMarkdown('<p>hi</p>')).toBe('<p>hi</p>')
	})
})
