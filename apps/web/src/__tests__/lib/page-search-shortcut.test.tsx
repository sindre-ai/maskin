import {
	focusField,
	handlePageSearchKeydown,
	registerPageSearch,
	usePageSearchShortcut,
	usePageSearchShortcutListener,
} from '@/lib/page-search-shortcut'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

function press(init: KeyboardEventInit & { key: string }) {
	const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init })
	document.dispatchEvent(event)
	return event
}

const cleanups: Array<() => void> = []
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
	document.body.innerHTML = ''
})

function register(focus: () => boolean | undefined) {
	cleanups.push(registerPageSearch(focus))
}

describe('handlePageSearchKeydown', () => {
	it('focuses the registered search and prevents the browser find', () => {
		const focus = vi.fn(() => true)
		register(focus)
		const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })
		handlePageSearchKeydown(event)
		expect(focus).toHaveBeenCalledTimes(1)
		expect(event.defaultPrevented).toBe(true)
	})

	it('accepts Ctrl+F as well as Cmd+F', () => {
		const focus = vi.fn(() => true)
		register(focus)
		handlePageSearchKeydown(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))
		expect(focus).toHaveBeenCalledTimes(1)
	})

	it('leaves the browser find alone when no page search is registered', () => {
		const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })
		handlePageSearchKeydown(event)
		expect(event.defaultPrevented).toBe(false)
	})

	it('does nothing with Shift or Alt held, or without Cmd/Ctrl', () => {
		const focus = vi.fn(() => true)
		register(focus)
		for (const init of [
			{ key: 'f', metaKey: true, shiftKey: true },
			{ key: 'f', metaKey: true, altKey: true },
			{ key: 'f' },
			{ key: 'g', metaKey: true },
		]) {
			const event = new KeyboardEvent('keydown', { cancelable: true, ...init })
			handlePageSearchKeydown(event)
			expect(event.defaultPrevented).toBe(false)
		}
		expect(focus).not.toHaveBeenCalled()
	})

	it('does not prevent the browser find when the search could not take focus', () => {
		register(() => false)
		const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })
		handlePageSearchKeydown(event)
		expect(event.defaultPrevented).toBe(false)
	})

	it('falls back to an earlier search when the newest one is hidden', () => {
		const first = vi.fn(() => true)
		register(first)
		register(() => false)
		handlePageSearchKeydown(new KeyboardEvent('keydown', { key: 'f', metaKey: true }))
		expect(first).toHaveBeenCalledTimes(1)
	})

	it('ignores the key while a dialog is open', () => {
		const focus = vi.fn(() => true)
		register(focus)
		document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true"></div>')
		const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })
		handlePageSearchKeydown(event)
		expect(focus).not.toHaveBeenCalled()
		expect(event.defaultPrevented).toBe(false)
	})
})

describe('handlePageSearchKeydown — who owns the key', () => {
	function keyFrom(target: Element, init: KeyboardEventInit = { key: 'f', ctrlKey: true }) {
		const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init })
		Object.defineProperty(event, 'target', { value: target })
		handlePageSearchKeydown(event)
		return event
	}

	afterEach(() => {
		window.history.pushState({}, '', '/')
		Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility')
	})

	it('leaves the browser find alone while typing in a textarea or a contenteditable', () => {
		const focus = vi.fn(() => true)
		register(focus)
		document.body.innerHTML =
			'<textarea id="t"></textarea><div contenteditable="true"><p id="c">x</p></div><div class="cm-editor"><span id="e"></span></div>'
		for (const id of ['t', 'c', 'e']) {
			expect(keyFrom(document.getElementById(id) as Element).defaultPrevented).toBe(false)
		}
		expect(focus).not.toHaveBeenCalled()
	})

	it('still works from the page search field itself', () => {
		const focus = vi.fn(() => true)
		register(focus)
		document.body.innerHTML = '<input type="search" id="s" />'
		expect(keyFrom(document.getElementById('s') as Element).defaultPrevented).toBe(true)
	})

	it('leaves the browser find alone while a chat thread is open', () => {
		const focus = vi.fn(() => true)
		register(focus)
		window.history.pushState({}, '', '/ws-1/chats/abc')
		expect(keyFrom(document.body).defaultPrevented).toBe(false)
		window.history.pushState({}, '', '/ws-1/chats')
		expect(keyFrom(document.body).defaultPrevented).toBe(true)
	})

	it('is not stopped by an inline, non-modal role=dialog card', () => {
		const focus = vi.fn(() => true)
		register(focus)
		document.body.innerHTML = '<span role="dialog" aria-label="Item preview"></span>'
		expect(keyFrom(document.body).defaultPrevented).toBe(true)
	})

	it('is not stopped by a modal that is hidden', () => {
		const focus = vi.fn(() => true)
		register(focus)
		document.body.innerHTML = '<div role="dialog" data-state="open"></div>'
		Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
			configurable: true,
			value: () => false,
		})
		expect(keyFrom(document.body).defaultPrevented).toBe(true)
	})
})

describe('page search registration', () => {
	function Page({ focus }: { focus: () => boolean }) {
		usePageSearchShortcut(focus)
		return null
	}
	function Shell() {
		usePageSearchShortcutListener()
		return null
	}

	it('is live while the page is mounted and gone after it unmounts', () => {
		const focus = vi.fn(() => true)
		render(<Shell />)
		const { unmount } = render(<Page focus={focus} />)
		expect(press({ key: 'f', metaKey: true }).defaultPrevented).toBe(true)
		expect(focus).toHaveBeenCalledTimes(1)

		unmount()
		expect(press({ key: 'f', metaKey: true }).defaultPrevented).toBe(false)
		expect(focus).toHaveBeenCalledTimes(1)
	})

	it('calls the latest focus function after a re-render', () => {
		const first = vi.fn(() => true)
		const second = vi.fn(() => true)
		render(<Shell />)
		const { rerender } = render(<Page focus={first} />)
		rerender(<Page focus={second} />)
		press({ key: 'f', ctrlKey: true })
		expect(first).not.toHaveBeenCalled()
		expect(second).toHaveBeenCalledTimes(1)
	})
})

describe('focusField', () => {
	it('focuses the input and selects its text', () => {
		document.body.innerHTML = '<input value="hello" />'
		const input = document.querySelector('input') as HTMLInputElement
		expect(focusField(input)).toBe(true)
		expect(document.activeElement).toBe(input)
		expect(input.selectionStart).toBe(0)
		expect(input.selectionEnd).toBe(5)
	})

	it('reports false for a missing field', () => {
		expect(focusField(null)).toBe(false)
	})
})
