import { createEmojiMenuView } from '@/components/chat/emoji-menu'
import type {
	EmojiItem,
	EmojiMenuState,
	EmojiMenuView,
} from '@maskin/markdown/react/emoji-suggestion'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const SMILE: EmojiItem = { shortcode: 'smile', emoji: '😄' }
const SMILEY: EmojiItem = { shortcode: 'smiley', emoji: '😃' }
const GRIN: EmojiItem = { shortcode: 'grin', emoji: '😁' }

function stateOf(items: EmojiItem[], query = 'smi') {
	return {
		query,
		items,
		clientRect: () => new DOMRect(10, 10, 0, 16),
		select: vi.fn(),
		dismiss: vi.fn(),
	} satisfies EmojiMenuState
}

const key = (name: string, init: KeyboardEventInit = {}) =>
	new KeyboardEvent('keydown', { key: name, ...init })

let view: EmojiMenuView | null = null

async function open(state: EmojiMenuState) {
	await act(async () => {
		view = createEmojiMenuView(state)
	})
	await screen.findByRole('listbox', { name: 'Emoji' })
}

afterEach(async () => {
	await act(async () => {
		view?.destroy()
		view = null
		await Promise.resolve()
	})
})

describe('emoji list', () => {
	it('lists each emoji with its name and highlights the first row', async () => {
		await open(stateOf([SMILE, SMILEY]))
		const rows = screen.getAllByRole('option')
		expect(rows).toHaveLength(2)
		expect(rows[0]).toHaveTextContent(':smile:')
		expect(rows[0]).toHaveAttribute('aria-selected', 'true')
		expect(rows[1]).toHaveAttribute('aria-selected', 'false')
	})

	it('moves the highlight with the arrow keys and wraps around', async () => {
		const state = stateOf([SMILE, SMILEY])
		await open(state)
		await act(async () => {
			expect(view?.onKeyDown(key('ArrowDown'))).toBe(true)
		})
		expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
		await act(async () => {
			view?.onKeyDown(key('ArrowDown'))
		})
		expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
		await act(async () => {
			view?.onKeyDown(key('ArrowUp'))
		})
		expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
	})

	it('picks the highlighted emoji with Enter and with Tab', async () => {
		const state = stateOf([SMILE, SMILEY])
		await open(state)
		await act(async () => {
			view?.onKeyDown(key('ArrowDown'))
		})
		expect(view?.onKeyDown(key('Enter'))).toBe(true)
		expect(state.select).toHaveBeenLastCalledWith(SMILEY)
		expect(view?.onKeyDown(key('Tab'))).toBe(true)
		expect(state.select).toHaveBeenCalledTimes(2)
	})

	it('leaves Shift+Enter and shortcuts to the box', async () => {
		const state = stateOf([SMILE])
		await open(state)
		expect(view?.onKeyDown(key('Enter', { shiftKey: true }))).toBe(false)
		expect(view?.onKeyDown(key('Enter', { metaKey: true }))).toBe(false)
		expect(view?.onKeyDown(key('a'))).toBe(false)
		expect(state.select).not.toHaveBeenCalled()
	})

	it('closes with Escape and keeps the typed text', async () => {
		const state = stateOf([SMILE])
		await open(state)
		expect(view?.onKeyDown(key('Escape'))).toBe(true)
		expect(state.dismiss).toHaveBeenCalledTimes(1)
		expect(state.select).not.toHaveBeenCalled()
	})

	it('picks a row on click', async () => {
		const state = stateOf([SMILE, GRIN])
		await open(state)
		fireEvent.click(screen.getAllByRole('option')[1] as HTMLElement)
		expect(state.select).toHaveBeenCalledWith(GRIN)
	})

	it('starts again at the top row when the query changes', async () => {
		await open(stateOf([SMILE, SMILEY]))
		await act(async () => {
			view?.onKeyDown(key('ArrowDown'))
		})
		await act(async () => {
			view?.update(stateOf([GRIN, SMILE], 'gr'))
		})
		await waitFor(() => {
			const rows = screen.getAllByRole('option')
			expect(rows[0]).toHaveTextContent(':grin:')
			expect(rows[0]).toHaveAttribute('aria-selected', 'true')
		})
	})

	it('removes the list when it closes', async () => {
		await open(stateOf([SMILE]))
		await act(async () => {
			view?.destroy()
			await Promise.resolve()
		})
		await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
		view = null
	})
})
