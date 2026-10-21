import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return { ...mockTanStackRouter(), useNavigate: () => mockNavigate }
})

const mockCreateConversation = vi.fn()
vi.mock('@/hooks/use-conversations', () => ({
	useCreateConversation: () => ({ mutateAsync: mockCreateConversation, isPending: false }),
}))

const mockDefaultAgent = vi.fn(() => ({ id: 'default-1', name: 'Workspace Coach' }))
vi.mock('@/hooks/use-actors', () => ({
	useDefaultChatAgent: () => mockDefaultAgent(),
	useActors: () => ({ data: [] }),
}))

const mockUseBriefings = vi.fn()
vi.mock('@/hooks/use-briefings', () => ({
	useBriefings: (...args: unknown[]) => mockUseBriefings(...args),
}))

import { BriefingRow } from '@/components/foryou/briefing-row'
import { TestWrapper } from '../../setup'

const cards = [
	{
		id: 'a',
		name: 'Briefing 2026-10-21.html',
		headline: 'Two bets stalled; one needs your call',
		author: { id: 'cos-1', name: 'Chief of Staff', type: 'agent' },
		updatedAt: '2026-10-21T05:00:00Z',
		html: '<h1>Two bets stalled; one needs your call</h1>',
	},
	{
		id: 'b',
		name: 'Pipeline.html',
		headline: 'Pipeline grew by four leads',
		author: { id: null, name: 'Sales Rep', type: 'agent' },
		updatedAt: '2026-10-20T05:00:00Z',
		html: '<h1>Pipeline grew by four leads</h1>',
	},
]

function renderRow() {
	return render(<BriefingRow workspaceId="ws-1" />, { wrapper: TestWrapper })
}

describe('BriefingRow', () => {
	beforeEach(() => {
		localStorage.clear()
		mockNavigate.mockClear()
		mockCreateConversation.mockReset()
		mockCreateConversation.mockResolvedValue({ id: 'conv-1' })
		mockUseBriefings.mockReturnValue({ cards, isLoading: false, isError: false })
	})

	it('draws nothing when there are no briefings', () => {
		mockUseBriefings.mockReturnValue({ cards: [], isLoading: false, isError: false })
		renderRow()
		expect(screen.queryByTestId('briefing-row')).toBeNull()
	})

	it('shows one card per briefing, titled by its page, marked new', () => {
		renderRow()
		expect(
			screen.getByRole('button', {
				name: /Chief of Staff: Two bets stalled; one needs your call, new/,
			}),
		).toBeInTheDocument()
		expect(screen.getAllByTestId('briefing-card')).toHaveLength(2)
	})

	it('opens the page in a sandboxed frame and marks the card seen', async () => {
		const user = userEvent.setup()
		renderRow()

		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		const frame = screen.getByTitle('Two bets stalled; one needs your call')
		expect(frame.tagName).toBe('IFRAME')
		// No allow-same-origin: agent-written HTML must stay off our origin.
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
		expect(screen.getByText(/1 of 2/)).toBeInTheDocument()
	})

	it('pages to the next briefing', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		await user.click(screen.getByRole('button', { name: /next/i }))

		expect(screen.getByText(/2 of 2/)).toBeInTheDocument()
		expect(screen.getByTitle('Pipeline grew by four leads')).toBeInTheDocument()
	})

	it('steps back with the left-hand button, which is off on the first briefing', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))
		expect(screen.getByRole('button', { name: 'Previous briefing' })).toBeDisabled()

		await user.click(screen.getByRole('button', { name: 'Next briefing' }))
		expect(screen.getByRole('button', { name: 'Next briefing' })).toBeDisabled()
		await user.click(screen.getByRole('button', { name: 'Previous briefing' }))

		expect(screen.getByText(/1 of 2/)).toBeInTheDocument()
	})

	it('"Tell me more" sends the question to the author with the page attached, then opens the chat', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		await user.click(screen.getByRole('button', { name: /tell me more/i }))

		expect(mockCreateConversation).toHaveBeenCalledTimes(1)
		const input = mockCreateConversation.mock.calls[0]?.[0]
		expect(input.participant_actor_ids).toEqual(['cos-1'])
		expect(input.initial_message).toContain('Tell me more about this briefing')
		expect(input.initial_message).toContain('Two bets stalled; one needs your call')
		// The page is a real attachment, not text pasted into the message.
		expect(input.initial_message).not.toContain('file_id')
		expect(input.initial_message_metadata).toEqual({
			attachments: [{ file_id: 'a', name: 'Briefing 2026-10-21.html', mime_type: 'text/html' }],
		})
		// The author's name is for the card, not for the question.
		expect(input.initial_message).not.toContain('from Chief of Staff')
		await waitFor(() =>
			expect(mockNavigate).toHaveBeenCalledWith({
				to: '/$workspaceId/chats/$conversationId',
				params: { workspaceId: 'ws-1', conversationId: 'conv-1' },
			}),
		)
		expect(screen.queryByTestId('briefing-viewer')).toBeNull()
	})

	it('"Tell me more" asks the default agent when the author is not a known agent', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Pipeline grew/ }))

		await user.click(screen.getByRole('button', { name: /tell me more/i }))

		expect(mockCreateConversation.mock.calls[0]?.[0].participant_actor_ids).toEqual(['default-1'])
	})

	it('"Tell me more" keeps the viewer open when the chat cannot be started', async () => {
		mockCreateConversation.mockRejectedValue(new Error('boom'))
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		await user.click(screen.getByRole('button', { name: /tell me more/i }))

		await waitFor(() => expect(mockCreateConversation).toHaveBeenCalled())
		expect(screen.getByTestId('briefing-viewer')).toBeInTheDocument()
		expect(mockNavigate).not.toHaveBeenCalled()
	})

	it('closes when the background around the frame is clicked', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		await user.click(screen.getByTestId('briefing-viewer'))

		expect(screen.queryByTestId('briefing-viewer')).toBeNull()
	})

	it('stays open when the page itself is clicked', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		await user.click(screen.getByText(/1 of 2/))

		expect(screen.getByTestId('briefing-viewer')).toBeInTheDocument()
	})

	it('"Open page" links to the file', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		expect(screen.getByRole('link', { name: 'Open page' })).toHaveAttribute(
			'href',
			'/$workspaceId/files/$fileId',
		)
	})

	it('moves between briefings with the arrow keys', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		await user.keyboard('{ArrowDown}')
		expect(screen.getByText(/2 of 2/)).toBeInTheDocument()

		await user.keyboard('{ArrowUp}')
		expect(screen.getByText(/1 of 2/)).toBeInTheDocument()
	})

	it('moves an opened card to the end of the row and drops its "new" mark', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))
		await user.keyboard('{Escape}')

		const [first, second] = screen.getAllByTestId('briefing-card')
		expect(first).toHaveAttribute('data-seen', 'false')
		expect(first).toHaveTextContent('Pipeline grew by four leads')
		expect(second).toHaveAttribute('data-seen', 'true')
	})
})
