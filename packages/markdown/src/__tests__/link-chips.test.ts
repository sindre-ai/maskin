// Link chips in the live editor: a drawing over the links the host recognises, plain while the
// cursor touches a link, and never part of the saved markdown.

import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { buildExtensions } from '../extensions'
import {
	type LinkChipHandlers,
	type LinkChipHost,
	createLinkChips,
	linkChipsKey,
	linkRuns,
	setLinkChips,
} from '../link-chips'

const A = 'https://maskin.io/ws/objects/00000000-0000-4000-8000-00000000000a'
const B = 'https://maskin.io/ws/objects/00000000-0000-4000-8000-00000000000b'

const DOC = `Read [the plan](${A}) and then **[bold *and* more](${B})** before [a site](https://example.com).\n`

function fakeHost(overrides: Partial<LinkChipHost> = {}) {
	const mounted: { container: HTMLElement; href: string; text: string; bare: boolean }[] = []
	const unmounted: HTMLElement[] = []
	const host: LinkChipHost = {
		maxLookups: 10,
		chipFor: (href) => (href.includes('/objects/') ? { lookup: href } : null),
		mount: (container, link) => mounted.push({ container, ...link }),
		unmount: (container) => unmounted.push(container),
		...overrides,
	}
	// The editor may build a chip element more than once while it starts up; the live ones are the
	// ones it has not since given back.
	const live = () => mounted.filter((m) => !unmounted.includes(m.container))
	return { host, live }
}

function open(markdown: string, host: LinkChipHost | null) {
	const handlers: { current: LinkChipHandlers } = { current: { host } }
	const editor = new Editor({
		extensions: buildExtensions('document', undefined, undefined, [createLinkChips(handlers)]),
		content: markdown,
	})
	if (host) setLinkChips(editor.view, host)
	return { editor, handlers, destroy: () => editor.destroy() }
}

const chips = (editor: Editor) => [...editor.view.dom.querySelectorAll('.maskin-link-chip')]
const hidden = (editor: Editor) =>
	[...editor.view.dom.querySelectorAll('.maskin-link-chip-source')].map((el) => el.textContent)

/** Put the cursor, as if the editor had focus and the person had clicked there. */
function focusAt(editor: Editor, pos: number) {
	const { view } = editor
	const tr = view.state.tr
		.setSelection(TextSelection.create(view.state.doc, pos))
		.setMeta(linkChipsKey, { focused: true })
	view.dispatch(tr)
}

describe('linkRuns', () => {
	it('keeps one run for a link with bold or italic inside it, and splits two links', () => {
		const { editor, destroy } = open(DOC, null)
		const runs = linkRuns(editor.state.doc)
		expect(runs.map((r) => r.href)).toEqual([A, B, 'https://example.com'])
		expect(editor.state.doc.textBetween(runs[1].from, runs[1].to)).toBe('bold and more')
		destroy()
	})
})

describe('link chips', () => {
	it('draws a chip for each recognised link and hides that link text', () => {
		const { host, live } = fakeHost()
		const { editor, destroy } = open(DOC, host)
		expect(chips(editor)).toHaveLength(2)
		expect(live().map((m) => m.href)).toEqual([A, B])
		expect(live().map((m) => m.text)).toEqual(['the plan', 'bold and more'])
		expect(hidden(editor).join('')).toBe('the planbold and more')
		destroy()
	})

	it('leaves an address the host does not recognise as a plain link', () => {
		const { host } = fakeHost()
		const { editor, destroy } = open(DOC, host)
		expect(editor.view.dom.querySelector('a[href="https://example.com"]')?.textContent).toBe(
			'a site',
		)
		destroy()
	})

	it('does not change the markdown that would be saved', () => {
		const withoutChips = open(DOC, null)
		const { host } = fakeHost()
		const withChips = open(DOC, host)
		expect(withChips.editor.storage.markdown.getMarkdown()).toBe(
			withoutChips.editor.storage.markdown.getMarkdown(),
		)
		withoutChips.destroy()
		withChips.destroy()
	})

	it('shows only the link the cursor touches as plain text, at either edge or inside', () => {
		const { host } = fakeHost()
		const { editor, destroy } = open(DOC, host)
		const [first, second] = linkRuns(editor.state.doc)
		for (const pos of [first.from, first.from + 3, first.to]) {
			focusAt(editor, pos)
			expect(hidden(editor).join('')).toBe('bold and more')
		}
		focusAt(editor, second.from + 2)
		expect(hidden(editor).join('')).toBe('the plan')
		destroy()
	})

	it('draws every link as a chip when the editor has no focus', () => {
		const { host } = fakeHost()
		const { editor, destroy } = open(DOC, host)
		const [first] = linkRuns(editor.state.doc)
		// A cursor in the link, but no focus: still a chip.
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, first.from + 1)),
		)
		expect(chips(editor)).toHaveLength(2)
		destroy()
	})

	it('gives a body at most maxLookups lookups and leaves the rest plain', () => {
		const links = Array.from(
			{ length: 12 },
			(_, i) =>
				`[link ${i}](https://maskin.io/ws/objects/00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')})`,
		)
		const { host } = fakeHost()
		const { editor, destroy } = open(links.join(' '), host)
		expect(chips(editor)).toHaveLength(10)
		destroy()
	})

	it('counts one lookup for the same object linked twice, and costs none for a chip with no lookup', () => {
		const { host } = fakeHost({
			maxLookups: 1,
			chipFor: (href) => (href === A ? { lookup: 'object:a' } : href === B ? {} : null),
		})
		const { editor, destroy } = open(`[one](${A}) [two](${A}) [three](${B})`, host)
		expect(chips(editor)).toHaveLength(3)
		destroy()
	})

	it('draws nothing without a host, and removes the chips when the host is taken away', () => {
		const { host, live } = fakeHost()
		const { editor, destroy } = open(DOC, host)
		expect(chips(editor)).toHaveLength(2)
		expect(live()).toHaveLength(2)
		setLinkChips(editor.view, null)
		expect(chips(editor)).toHaveLength(0)
		expect(live()).toHaveLength(0)
		expect(editor.view.dom.querySelector(`a[href="${A}"]`)?.textContent).toBe('the plan')
		destroy()
	})

	it('hands the host the link text, and says when that text is only the address', () => {
		const { host, live } = fakeHost()
		const { destroy } = open(`[the plan](${A}) [${B}](${B}) [${B}/](${B})`, host)
		expect(live().map((m) => m.bare)).toEqual([false, true, true])
		expect(live()[0].text).toBe('the plan')
		destroy()
	})

	it('cancels the press on a chip, so the cursor does not move, and leaves the click alone', () => {
		const { host, live } = fakeHost()
		const { editor, destroy } = open(DOC, host)
		const before = editor.state.selection.from
		const chip = live()[0].container
		const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
		chip.dispatchEvent(press)
		expect(press.defaultPrevented).toBe(true)
		const click = new MouseEvent('click', { bubbles: true, cancelable: true })
		chip.dispatchEvent(click)
		expect(click.defaultPrevented).toBe(false)
		expect(editor.state.selection.from).toBe(before)
		destroy()
	})
})
