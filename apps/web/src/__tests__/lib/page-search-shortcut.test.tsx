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
		document.body.insertAdjacentHTML('beforeend', '<div role="dialog"></div>')
		const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })
		handlePageSearchKeydown(event)
		expect(focus).not.toHaveBeenCalled()
		expect(event.defaultPrevented).toBe(false)
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
