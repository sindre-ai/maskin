import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	EMOJI_ITEMS,
	EMOJI_MAX_RESULTS,
	type EmojiMenuState,
	type EmojiMenuView,
	EmojiSuggestion,
	filterEmoji,
} from '../react/emoji-suggestion'

interface Harness {
	editor: Editor
	states: EmojiMenuState[]
	destroyed: ReturnType<typeof vi.fn>
	onEmojiPicked: ReturnType<typeof vi.fn>
}

function mount(content = ''): Harness {
	const states: EmojiMenuState[] = []
	const destroyed = vi.fn()
	const onEmojiPicked = vi.fn()
	const editor = new Editor({
		content,
		extensions: [
			StarterKit,
			EmojiSuggestion.configure({
				onEmojiPicked,
				createView: (state): EmojiMenuView => {
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
	return { editor, states, destroyed, onEmojiPicked }
}

/** The suggestion plugin awaits the item list, so the view sees a keystroke one tick later. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function type(editor: Editor, text: string) {
	for (const char of text) {
		editor.commands.insertContent(char)
		await settle()
	}
}

describe('EMOJI_ITEMS', () => {
	it('has unique lowercase shortcodes without colons or spaces', () => {
		const codes = EMOJI_ITEMS.map((i) => i.shortcode)
		expect(new Set(codes).size).toBe(codes.length)
		for (const code of codes) expect(code).toMatch(/^[a-z0-9_]+$/)
	})
})

describe('filterEmoji', () => {
	it('returns nothing until two characters are typed', () => {
		expect(filterEmoji('')).toEqual([])
		expect(filterEmoji('s')).toEqual([])
	})

	it('finds the smiley for "smi"', () => {
		const ids = filterEmoji('smi').map((i) => i.shortcode)
		expect(ids).toContain('smile')
		expect(ids[0]).toBe('smile')
	})

	it('is case-insensitive and trims', () => {
		expect(filterEmoji(' SMI ').map((i) => i.shortcode)).toEqual(
			filterEmoji('smi').map((i) => i.shortcode),
		)
	})

	it('lists shortcodes that start with the query before ones that only contain it', () => {
		// kissing_heart is listed before heart, so only the ranking puts heart first. The cap
		// of 8 rows would cut it off, so lift it.
		const ids = filterEmoji('heart', EMOJI_ITEMS, 100).map((i) => i.shortcode)
		expect(ids.indexOf('heart')).toBeGreaterThanOrEqual(0)
		expect(ids.indexOf('heart')).toBeLessThan(ids.indexOf('kissing_heart'))
	})

	it('finds an emoji by an alias', () => {
		expect(filterEmoji('lol').map((i) => i.shortcode)).toContain('joy')
	})

	it('caps the list', () => {
		expect(filterEmoji('ar').length).toBeLessThanOrEqual(EMOJI_MAX_RESULTS)
	})
})

describe('EmojiSuggestion', () => {
	let h: Harness | null = null
	afterEach(() => {
		h?.editor.destroy()
		h = null
	})

	it('opens after ":sm" with matching rows and stays closed for ":s"', async () => {
		h = mount()
		await type(h.editor, ':s')
		expect(h.states).toHaveLength(0)
		await type(h.editor, 'm')
		expect(h.states.length).toBeGreaterThan(0)
		expect(h.states.at(-1)?.items.map((i) => i.shortcode)).toContain('smile')
	})

	it('swaps the typed text for the emoji on select and keeps the rest of the line', async () => {
		h = mount()
		await type(h.editor, 'hi :smi')
		const state = h.states.at(-1)
		const smile = state?.items.find((i) => i.shortcode === 'smile')
		expect(smile).toBeDefined()
		if (!smile) return
		state?.select(smile)
		expect(h.editor.getText()).toBe(`hi ${smile.emoji}`)
		expect(h.onEmojiPicked).toHaveBeenCalledWith('smile')
	})

	it('does not open inside a word, a time or a link', async () => {
		h = mount()
		await type(h.editor, 'at 12:30 and https://example.com and a:smile')
		expect(h.states).toHaveLength(0)
	})

	it('does not open inside inline code', async () => {
		h = mount('<p><code>x</code></p>')
		h.editor.commands.focus('end')
		h.editor.commands.setMark('code')
		await type(h.editor, ' :smi')
		expect(h.states).toHaveLength(0)
	})

	it('closes the list when nothing matches any more', async () => {
		h = mount()
		await type(h.editor, ':smi')
		expect(h.states.length).toBeGreaterThan(0)
		await type(h.editor, 'zzzz')
		expect(h.destroyed).toHaveBeenCalled()
	})

	it('stays closed for a dismissed colon until the colon goes', async () => {
		h = mount()
		await type(h.editor, ':smi')
		h.states.at(-1)?.dismiss()
		await settle()
		expect(h.destroyed).toHaveBeenCalled()
		const opened = h.states.length
		await type(h.editor, 'l')
		expect(h.states).toHaveLength(opened)
		expect(h.editor.getText()).toBe(':smil')
	})
})
