import { SlashCommandMenu } from '@/components/editor/slash-command'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

// jsdom can't drive ProseMirror suggestion decorations, so keyboard/render
// coverage for the picker lives on the pure React menu component. The full
// integration path (typing `/`, filtering, inserting a block) is exercised
// by the e2e spec.

const ITEMS = [
	{
		title: 'Heading 1',
		description: 'Large section title',
		keywords: ['h1'],
		// biome-ignore lint/suspicious/noExplicitAny: icon is a Lucide component; not exercised in these tests
		icon: (() => null) as any,
		run: vi.fn(),
	},
	{
		title: 'Bullet list',
		description: 'Unordered list',
		keywords: ['ul'],
		// biome-ignore lint/suspicious/noExplicitAny: icon is a Lucide component; not exercised in these tests
		icon: (() => null) as any,
		run: vi.fn(),
	},
]

describe('SlashCommandMenu', () => {
	it('renders each item and mouse selection fires the command', () => {
		const command = vi.fn()
		render(<SlashCommandMenu items={ITEMS} command={command} />)
		const menu = screen.getByRole('menu', { name: 'Slash commands' })
		expect(menu).toBeInTheDocument()
		const heading1 = screen.getByRole('menuitem', { name: /Heading 1/ })
		fireEvent.mouseDown(heading1)
		expect(command).toHaveBeenCalledWith(ITEMS[0])
	})

	it('exposes onKeyDown that navigates ArrowUp/ArrowDown and inserts on Enter', () => {
		const command = vi.fn()
		const ref = createRef<{ onKeyDown: (event: KeyboardEvent) => boolean }>()
		render(<SlashCommandMenu ref={ref} items={ITEMS} command={command} />)

		const press = (key: string) => {
			let handled = false
			act(() => {
				handled = ref.current?.onKeyDown(new KeyboardEvent('keydown', { key })) ?? false
			})
			return handled
		}

		// The first item is selected by default; Enter inserts it.
		expect(press('Enter')).toBe(true)
		expect(command).toHaveBeenLastCalledWith(ITEMS[0])

		// ArrowDown moves selection to the second item; Enter now inserts it.
		expect(press('ArrowDown')).toBe(true)
		expect(press('Enter')).toBe(true)
		expect(command).toHaveBeenLastCalledWith(ITEMS[1])

		// Unrelated keys are not handled — the editor keeps them.
		expect(press('a')).toBe(false)
	})

	it('renders an empty-state row when no items match', () => {
		render(<SlashCommandMenu items={[]} command={vi.fn()} />)
		expect(screen.getByText('No matches')).toBeInTheDocument()
	})
})
