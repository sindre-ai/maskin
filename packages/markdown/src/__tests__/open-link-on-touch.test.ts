// A tap on a link opens it; a tap on plain text and a mouse click leave the cursor alone.

import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildExtensions, openLinkOnTouch } from '../extensions'

const DOC = 'Read [the plan](https://example.com/plan) then plain text and [a page](/relative).\n'

function press(editor: Editor, target: Element, pointerType: string): boolean {
	const down = new Event('pointerdown', { bubbles: true })
	Object.defineProperty(down, 'pointerType', { value: pointerType })
	target.dispatchEvent(down)
	const up = new MouseEvent('mouseup', { bubbles: true })
	Object.defineProperty(up, 'target', { value: target })
	return Boolean(editor.view.someProp('handleClick', (f) => f(editor.view, 1, up) || undefined))
}

describe('open a link on touch', () => {
	let editor: Editor | undefined
	afterEach(() => {
		editor?.destroy()
		vi.restoreAllMocks()
	})

	function open() {
		editor = new Editor({
			extensions: buildExtensions('document', undefined, undefined, undefined),
			content: DOC,
		})
		const spy = vi.spyOn(window, 'open').mockImplementation(() => null)
		const links = [...editor.view.dom.querySelectorAll('a')]
		const text = editor.view.dom.querySelector('p') as Element
		return { editor, spy, links, text }
	}

	it('opens an http link in a new tab on a tap, and leaves the click to nobody else', () => {
		const { editor, spy, links } = open()
		expect(press(editor, links[0], 'touch')).toBe(true)
		expect(spy).toHaveBeenCalledWith('https://example.com/plan', '_blank', 'noopener,noreferrer')
	})

	it('does nothing on a tap on plain text, so the cursor moves as before', () => {
		const { editor, spy, text } = open()
		expect(press(editor, text, 'touch')).toBe(false)
		expect(spy).not.toHaveBeenCalled()
	})

	it('does nothing on a mouse click on a link, so desktop editing is unchanged', () => {
		const { editor, spy, links } = open()
		expect(press(editor, links[0], 'mouse')).toBe(false)
		expect(spy).not.toHaveBeenCalled()
	})

	it('leaves a relative link and a chip alone', () => {
		const { editor, spy, links } = open()
		expect(press(editor, links[1], 'touch')).toBe(false)
		const chip = document.createElement('span')
		chip.className = 'maskin-link-chip'
		const inner = document.createElement('a')
		inner.setAttribute('href', 'https://example.com/chip')
		chip.append(inner)
		expect(openLinkOnTouch(inner, 'touch', spy)).toBe(false)
		expect(spy).not.toHaveBeenCalled()
	})
})
