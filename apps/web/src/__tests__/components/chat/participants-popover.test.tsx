import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const removeMutate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

vi.mock('@/components/ui/responsive-popover', () => ({
	ResponsivePopover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	ResponsivePopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	ResponsivePopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

let working: Array<{ actorId: string; currentActivity: string | null }> = []
vi.mock('@/hooks/use-active-agents', () => ({ useActiveAgents: () => ({ agents: working }) }))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [{ id: 'forge-1', name: 'Forge', type: 'agent' }] }),
}))

vi.mock('@/hooks/use-conversation', () => ({
	useAddConversationParticipants: () => ({ mutate: vi.fn() }),
	useRemoveConversationParticipant: () => ({ mutate: removeMutate }),
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

	it('groups people and agents, shows Working or Idle for agents, and labels Leave and Remove', async () => {
		working = [{ actorId: 'strat-1', currentActivity: 'pricing options' }]
		render(
			<ParticipantsPopover
				workspaceId="ws-1"
				conversationId="c-1"
				participants={[
					{
						actorId: 'strat-1',
						actorName: 'Strategist',
						actorType: 'agent',
						joinedAt: '',
						addedBy: null,
					},
					{
						actorId: 'seo-1',
						actorName: 'SEO Researcher',
						actorType: 'agent',
						joinedAt: '',
						addedBy: null,
					},
					{
						actorId: 'sam-1',
						actorName: 'Sam Rivers',
						actorType: 'human',
						joinedAt: '',
						addedBy: null,
					},
					{ actorId: 'me-1', actorName: 'You', actorType: 'human', joinedAt: '', addedBy: null },
				]}
				createdBy="me-1"
			>
				<button type="button">Participants</button>
			</ParticipantsPopover>,
		)
		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: 'Participants' }))

		expect(screen.getByText('People · 2')).toBeInTheDocument()
		expect(screen.getByText('Agents · 2')).toBeInTheDocument()
		expect(screen.getByText('Working now · pricing options')).toBeInTheDocument()
		expect(screen.getAllByText('Idle').length).toBeGreaterThan(0)
		expect(screen.getByText('You · owner of this chat')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Leave chat' }))
		expect(removeMutate).toHaveBeenCalledWith('me-1', expect.anything())
		await user.click(screen.getByRole('button', { name: 'Remove Strategist' }))
		expect(removeMutate).toHaveBeenCalledWith('strat-1', expect.anything())
	})
})
