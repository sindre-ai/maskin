import { ConversationListHeader } from '@/components/chat/conversation-list'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

function Harness({ pageTitle = true, titled = true }: { pageTitle?: boolean; titled?: boolean }) {
	const [query, setQuery] = useState('')
	return (
		<ConversationListHeader
			filter="all"
			onFilterChange={() => {}}
			query={query}
			onQueryChange={setQuery}
			workspaceId="ws-1"
			titled={titled}
			pageTitle={pageTitle}
		/>
	)
}

describe('ConversationListHeader', () => {
	it('is the page heading, exactly one level-1 heading, before any search', () => {
		render(<Harness />, { wrapper: TestWrapper })
		expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
		expect(screen.getByRole('heading', { level: 1, name: 'Chats' })).toBeVisible()
	})

	it('keeps exactly one level-1 heading, visually hidden, while the search is focused or has text', async () => {
		const user = userEvent.setup()
		render(<Harness />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('searchbox', { name: 'Search chats' }))
		expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
		expect(screen.getByRole('heading', { level: 1 })).toHaveClass('sr-only')

		await user.type(screen.getByRole('searchbox', { name: 'Search chats' }), 'billing')
		await user.tab()
		expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
		expect(screen.getByRole('heading', { level: 1 })).toHaveClass('sr-only')
	})

	it('draws a level-2 heading on the new-chat screen, where the nav row owns the h1', () => {
		render(<Harness pageTitle={false} />, { wrapper: TestWrapper })
		expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
		expect(screen.getByRole('heading', { level: 2, name: 'Chats' })).toBeInTheDocument()
	})

	it.each([
		['titled pill', true],
		['plain field', false],
	])('Esc clears the text and leaves the search field (%s)', async (_name, titled) => {
		const user = userEvent.setup()
		render(<Harness titled={titled} />, { wrapper: TestWrapper })
		const box = screen.getByRole('searchbox', { name: 'Search chats' })

		await user.type(box, 'billing')
		expect(box).toHaveValue('billing')
		expect(box).toHaveFocus()

		await user.keyboard('{Escape}')
		expect(box).toHaveValue('')
		expect(box).not.toHaveFocus()
	})
})
