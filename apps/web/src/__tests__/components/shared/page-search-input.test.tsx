import { PageSearchInput } from '@/components/shared/page-search-input'
import { usePageSearchShortcutListener } from '@/lib/page-search-shortcut'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

function Harness({
	debounceMs,
	onChange,
}: { debounceMs?: number; onChange?: (v: string) => void }) {
	const [value, setValue] = useState('')
	return (
		<>
			<PageSearchInput
				value={value}
				onChange={(next) => {
					setValue(next)
					onChange?.(next)
				}}
				label="Search items"
				debounceMs={debounceMs}
			/>
			<button type="button" onClick={() => setValue('')}>
				clear from outside
			</button>
		</>
	)
}

afterEach(() => {
	vi.useRealTimers()
})

describe('PageSearchInput', () => {
	it('reports typing straight away without a debounce', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<Harness onChange={onChange} />)
		await user.type(screen.getByRole('searchbox', { name: 'Search items' }), 'ab')
		expect(onChange).toHaveBeenLastCalledWith('ab')
	})

	it('holds typing back for the debounce, then reports the last text once', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
		const onChange = vi.fn()
		render(<Harness debounceMs={250} onChange={onChange} />)
		await user.type(screen.getByRole('searchbox', { name: 'Search items' }), 'abc')
		expect(onChange).not.toHaveBeenCalled()
		await act(async () => {
			vi.advanceTimersByTime(260)
		})
		expect(onChange).toHaveBeenCalledTimes(1)
		expect(onChange).toHaveBeenCalledWith('abc')
	})

	it('replaces the text when the value is cleared from outside', async () => {
		const user = userEvent.setup()
		render(<Harness />)
		const box = screen.getByRole('searchbox', { name: 'Search items' })
		await user.type(box, 'abc')
		await user.click(screen.getByRole('button', { name: 'clear from outside' }))
		expect(box).toHaveValue('')
	})

	it('is an icon below md that opens an inline field, and closes again', async () => {
		const user = userEvent.setup()
		render(<Harness />)
		// jsdom has no CSS, so the desktop field is in the tree too: one searchbox.
		expect(screen.getAllByRole('searchbox')).toHaveLength(1)
		await user.click(screen.getByRole('button', { name: 'Search items' }))
		expect(screen.getAllByRole('searchbox')).toHaveLength(2)
		await user.click(screen.getByRole('button', { name: 'Close search' }))
		expect(screen.getAllByRole('searchbox')).toHaveLength(1)
		expect(screen.getByRole('button', { name: 'Search items' })).toHaveFocus()
	})

	it('closes the inline field with Escape', async () => {
		const user = userEvent.setup()
		render(<Harness />)
		await user.click(screen.getByRole('button', { name: 'Search items' }))
		const [, inline] = screen.getAllByRole('searchbox')
		expect(inline).toHaveFocus()
		await user.keyboard('{Escape}')
		expect(screen.getAllByRole('searchbox')).toHaveLength(1)
		expect(screen.getByRole('button', { name: 'Search items' })).toHaveFocus()
	})

	describe('Cmd/Ctrl+F', () => {
		function Shell() {
			usePageSearchShortcutListener()
			return null
		}

		afterEach(() => {
			// Removes the stub a test added to the prototype.
			Reflect.deleteProperty(HTMLElement.prototype, 'checkVisibility')
		})

		it('focuses and selects the field where it is on screen', async () => {
			const user = userEvent.setup()
			render(
				<>
					<Shell />
					<Harness />
				</>,
			)
			const box = screen.getByRole('searchbox', { name: 'Search items' })
			await user.type(box, 'abc')
			;(document.activeElement as HTMLElement).blur()
			await user.keyboard('{Control>}f{/Control}')
			expect(box).toHaveFocus()
			expect((box as HTMLInputElement).selectionEnd).toBe(3)
		})

		it('opens the inline field and focuses it where the field is collapsed to the icon', async () => {
			// The wide field is display:none below xl.
			Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
				configurable: true,
				value() {
					return !this.closest('.hidden')
				},
			})
			const user = userEvent.setup()
			render(
				<>
					<Shell />
					<Harness />
				</>,
			)
			expect(screen.getAllByRole('searchbox')).toHaveLength(1)
			await user.keyboard('{Control>}f{/Control}')
			const boxes = screen.getAllByRole('searchbox')
			expect(boxes).toHaveLength(2)
			expect(boxes[1]).toHaveFocus()
		})
	})
})
