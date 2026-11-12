import { ChatListViewSwitch } from '@/components/chat/chat-list-view-switch'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('ChatListViewSwitch', () => {
	it('marks the current view and offers the other one', () => {
		render(<ChatListViewSwitch value="agents" onChange={vi.fn()} />)
		expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true')
		expect(screen.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'false')
	})

	it('reports the view that was tapped', async () => {
		const onChange = vi.fn()
		render(<ChatListViewSwitch value="agents" onChange={onChange} />)
		await userEvent.click(screen.getByRole('tab', { name: 'Recent' }))
		expect(onChange).toHaveBeenCalledWith('recent')
	})
})
