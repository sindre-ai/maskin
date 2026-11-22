import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', () => ({
	api: {
		conversations: { get: vi.fn(), updateMe: vi.fn() },
	},
}))

import { ArchivedBar } from '@/components/chat/archived-bar'
import { api } from '@/lib/api'

describe('ArchivedBar', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.get).mockReset()
		vi.mocked(api.conversations.updateMe).mockReset()
	})

	it('shows nothing for a chat that is not archived', async () => {
		vi.mocked(api.conversations.get).mockResolvedValue({ id: 'c1', archived: false } as never)
		render(<ArchivedBar workspaceId="ws-1" conversationId="c1" />, { wrapper: TestWrapper })

		await waitFor(() => expect(api.conversations.get).toHaveBeenCalled())
		expect(screen.queryByText('Archived.')).not.toBeInTheDocument()
	})

	it('offers Unarchive on an archived chat and unarchives it on click', async () => {
		vi.mocked(api.conversations.get).mockResolvedValue({ id: 'c1', archived: true } as never)
		vi.mocked(api.conversations.updateMe).mockResolvedValue({} as never)
		const user = userEvent.setup()
		render(<ArchivedBar workspaceId="ws-1" conversationId="c1" />, { wrapper: TestWrapper })

		expect(await screen.findByText('Archived.')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Unarchive' }))
		await waitFor(() =>
			expect(api.conversations.updateMe).toHaveBeenCalledWith('c1', 'ws-1', { archived: false }),
		)
	})
})
