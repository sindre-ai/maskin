import { TopNav } from '@/components/layout/top-nav'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('TopNav', () => {
	it('renders tabs and marks the active one via aria-pressed', () => {
		render(
			<TopNav
				tabs={[
					{ key: 'inbox', label: 'Inbox' },
					{ key: 'archive', label: 'Archive' },
				]}
				activeTabKey="archive"
			/>,
		)

		const inbox = screen.getByRole('button', { name: 'Inbox' })
		const archive = screen.getByRole('button', { name: 'Archive' })
		expect(inbox).toHaveAttribute('aria-pressed', 'false')
		expect(archive).toHaveAttribute('aria-pressed', 'true')
	})

	it('fires onTabChange with the tab key', async () => {
		const onTabChange = vi.fn()
		render(
			<TopNav
				tabs={[{ key: 'inbox', label: 'Inbox' }]}
				activeTabKey="inbox"
				onTabChange={onTabChange}
			/>,
		)

		await userEvent.click(screen.getByRole('button', { name: 'Inbox' }))
		expect(onTabChange).toHaveBeenCalledWith('inbox')
	})

	it('renders filter chips with their count and forwards clicks', async () => {
		const onClick = vi.fn()
		render(
			<TopNav
				filters={[
					{ key: 'bets', label: 'Bets', count: 12, active: true, onClick },
					{ key: 'tasks', label: 'Tasks', count: 64 },
				]}
			/>,
		)

		const activeChip = screen.getByRole('button', { name: /Bets\s*12/ })
		expect(activeChip).toHaveAttribute('aria-pressed', 'true')
		expect(screen.getByRole('button', { name: /Tasks\s*64/ })).toBeInTheDocument()

		await userEvent.click(activeChip)
		expect(onClick).toHaveBeenCalledTimes(1)
	})

	it('renders the more + menu triggers with correct labels', () => {
		render(<TopNav moreLabel="More options" menuLabel="Theme · Light" />)
		expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument()
		expect(screen.getByText('Theme · Light')).toBeInTheDocument()
	})
})
