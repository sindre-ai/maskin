import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const mockUseBriefing = vi.fn()
vi.mock('@/hooks/use-briefing', () => ({
	useBriefing: (...args: unknown[]) => mockUseBriefing(...args),
}))

const createConversationMutateAsync = vi.fn()
vi.mock('@/hooks/use-conversations', () => ({
	useCreateConversation: () => ({ mutateAsync: createConversationMutateAsync, isPending: false }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useDefaultChatAgent: () => ({ id: 'agent-1', name: 'Workspace Coach' }),
	useActors: () => ({ data: [] }),
	useActor: () => ({ data: undefined }),
}))

// The chat Composer drags in the whole chat surface (uploads, slash picker,
// SSE); the drawer only cares that a send routes through onSend.
vi.mock('@/components/chat/chat', () => ({
	Composer: ({
		onSend,
		placeholder,
	}: {
		onSend: (content: string) => Promise<void>
		placeholder?: string
	}) => (
		<button type="button" onClick={() => void onSend('Turn this into a task')}>
			{placeholder}
		</button>
	),
}))

import { BriefDrawer, splitBriefHeadline } from '@/components/foryou/brief-drawer'
import { TestWrapper } from '../../setup'

describe('splitBriefHeadline', () => {
	it('lifts a leading H1 out of the markdown body', () => {
		const { headline, body } = splitBriefHeadline('# Acme — workspace briefing\n\nBody line.')
		expect(headline).toBe('Acme — workspace briefing')
		expect(body.trim()).toBe('Body line.')
	})

	it('leaves the document intact when it has no leading heading', () => {
		const { headline, body } = splitBriefHeadline('Just a paragraph.')
		expect(headline).toBeNull()
		expect(body).toBe('Just a paragraph.')
	})
})

describe('BriefDrawer', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseBriefing.mockReturnValue({
			data: { workspace_id: 'ws-1', markdown: '# Your Monday brief\n\nTwo bets need a read.' },
			isLoading: false,
			isError: false,
			error: null,
			refetch: vi.fn(),
		})
	})

	it('renders nothing until it is opened', () => {
		render(<BriefDrawer workspaceId="ws-1" open={false} onOpenChange={vi.fn()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.queryByTestId('brief-drawer')).not.toBeInTheDocument()
	})

	it('renders the briefing headline and body when open', () => {
		render(<BriefDrawer workspaceId="ws-1" open onOpenChange={vi.fn()} />, {
			wrapper: TestWrapper,
		})

		expect(screen.getByText('Your brief')).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'Your Monday brief' })).toBeInTheDocument()
		expect(screen.getByText('Two bets need a read.')).toBeInTheDocument()
	})

	it('closes on Escape', async () => {
		const user = userEvent.setup()
		const onOpenChange = vi.fn()
		render(<BriefDrawer workspaceId="ws-1" open onOpenChange={onOpenChange} />, {
			wrapper: TestWrapper,
		})

		await user.keyboard('{Escape}')
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it('sends a follow-up through useCreateConversation and closes the drawer', async () => {
		const user = userEvent.setup()
		const onOpenChange = vi.fn()
		createConversationMutateAsync.mockResolvedValue({ id: 'conv-1' })
		render(<BriefDrawer workspaceId="ws-1" open onOpenChange={onOpenChange} />, {
			wrapper: TestWrapper,
		})

		await user.click(
			screen.getByRole('button', {
				name: 'Ask Workspace Coach to turn any of this into a task…',
			}),
		)

		await waitFor(() =>
			expect(createConversationMutateAsync).toHaveBeenCalledWith({
				title: 'Workspace Coach',
				participant_actor_ids: ['agent-1'],
				initial_message: 'Turn this into a task',
			}),
		)
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})
})
