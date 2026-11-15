import { CommentFilters, EMPTY_COMMENT_FILTER_STATE } from '@/components/triggers/comment-filters'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({
		data: [
			{ id: 'a1', name: 'Ada', type: 'human' },
			{ id: 'a2', name: 'Bo', type: 'agent' },
			{ id: 'a3', name: 'Cy', type: 'agent' },
		],
	}),
}))

function Harness({ onState }: { onState: (id: string | null) => void }) {
	const [value, setValue] = useState(EMPTY_COMMENT_FILTER_STATE)
	return (
		<CommentFilters
			workspaceId="w1"
			value={value}
			onChange={(next) => {
				setValue(next)
				onState(next.authorId)
			}}
		/>
	)
}

describe('actor filter keyboard', () => {
	it('ArrowDown opens the list, arrows move, Enter picks', async () => {
		const user = userEvent.setup()
		const onState = vi.fn()
		render(<Harness onState={onState} />)
		const combobox = document.getElementById('comment-filter-author') as HTMLElement
		combobox.focus()
		await user.keyboard('{ArrowDown}')
		expect(combobox.getAttribute('aria-expanded')).toBe('true')
		await user.keyboard('{ArrowDown}{Enter}')
		expect(onState).toHaveBeenLastCalledWith('a2')
		expect(combobox.getAttribute('aria-expanded')).toBe('false')
	})

	it('Esc closes and returns focus to the combobox', async () => {
		const user = userEvent.setup()
		render(<Harness onState={vi.fn()} />)
		const combobox = document.getElementById('comment-filter-author') as HTMLElement
		combobox.focus()
		await user.keyboard('{ArrowDown}')
		await user.keyboard('{Escape}')
		expect(combobox.getAttribute('aria-expanded')).toBe('false')
		expect(document.activeElement).toBe(combobox)
	})

	it('keeps the clear button outside the combobox', async () => {
		const user = userEvent.setup()
		render(<Harness onState={vi.fn()} />)
		const combobox = document.getElementById('comment-filter-author') as HTMLElement
		combobox.focus()
		await user.keyboard('{ArrowDown}{Enter}')
		const clear = screen.getAllByRole('button', { name: 'Clear selection' })[0]
		expect(combobox.contains(clear)).toBe(false)
	})
})
