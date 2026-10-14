import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

vi.mock('@/components/ui/responsive-popover', () => ({
	ResponsivePopover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	ResponsivePopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	ResponsivePopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [{ id: 'forge-1', name: 'Forge', type: 'agent' }] }),
}))

vi.mock('@/hooks/use-conversation', () => ({
	useAddConversationParticipants: () => ({ mutate: vi.fn() }),
	useRemoveConversationParticipant: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: () => ({
		data: [
			{ actorId: 'slack-1', name: 'Slack', type: 'system', role: 'member' },
			{ actorId: 'sam-1', name: 'Sam Rivers', type: 'human', role: 'member' },
		],
	}),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'me-1', name: 'You', type: 'human' }),
}))

import { ParticipantsPopover } from '@/components/chat/participants-popover'

describe('ParticipantsPopover', () => {
	it('offers people and agents to add but never integration system members', async () => {
		render(
			<ParticipantsPopover
				workspaceId="ws-1"
				conversationId="c-1"
				participants={[]}
				createdBy="me-1"
			>
				<button type="button">Participants</button>
			</ParticipantsPopover>,
		)
		await userEvent.setup().click(screen.getByRole('button', { name: 'Participants' }))
		expect(await screen.findByText('Sam Rivers')).toBeInTheDocument()
		expect(screen.getByText('Forge')).toBeInTheDocument()
		expect(screen.queryByText('Slack')).not.toBeInTheDocument()
	})
})
