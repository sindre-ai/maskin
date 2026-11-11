import {
	SlackDirectPostChannels,
	savedDirectPostChannels,
} from '@/components/integrations/slack-direct-post-channels'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildIntegrationResponse } from '../../factories'

const CHANNELS = [
	{ id: 'C0BR48J5WG5', name: 'maskin-app', is_private: false, is_member: true },
	{ id: 'C06LC37JJCS', name: 'development', is_private: false, is_member: true },
	{ id: 'C0SECRET0001', name: 'leadership', is_private: true, is_member: true },
]

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))

const save = vi.fn()
vi.mock('@/hooks/use-integrations', () => ({
	useSlackConversations: () => ({ data: CHANNELS, isLoading: false, isError: false }),
	useSetSlackDirectPostChannels: () => ({ mutate: save, isPending: false, variables: undefined }),
}))

const mockRole = vi.fn(() => 'owner')
vi.mock('@/lib/workspace-context', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/workspace-context')>()),
	useWorkspace: () => ({ workspace: { role: mockRole() }, workspaceId: 'ws-1' }),
}))

const mockActor = vi.fn<() => { id: string; type: string } | null>(() => ({
	id: 'human-1',
	type: 'human',
}))
vi.mock('@/lib/auth', () => ({ getStoredActor: () => mockActor() }))

beforeEach(() => {
	vi.clearAllMocks()
	mockRole.mockReturnValue('owner')
	mockActor.mockReturnValue({ id: 'human-1', type: 'human' })
})

function renderCard(config: Record<string, unknown> = {}) {
	const user = userEvent.setup()
	render(
		<SlackDirectPostChannels
			integration={buildIntegrationResponse({ id: 'int-1', config })}
			workspaceId="ws-1"
		/>,
	)
	return { user }
}

describe('savedDirectPostChannels', () => {
	it('is undefined until a list was saved, and an empty list is a saved list', () => {
		expect(savedDirectPostChannels({})).toBeUndefined()
		expect(savedDirectPostChannels({ slack_direct_post_channels: [] })).toEqual([])
		expect(savedDirectPostChannels({ slack_direct_post_channels: ['C0BR48J5WG5', 7] })).toEqual([
			'C0BR48J5WG5',
		])
	})
})

describe('SlackDirectPostChannels', () => {
	it('says every post waits for approval when no list was saved', () => {
		renderCard()
		expect(screen.getByText(/every Slack post waits for a person to approve it/)).toBeTruthy()
	})

	it('shows the saved channels and lists every channel with a check on the saved ones', async () => {
		const { user } = renderCard({ slack_direct_post_channels: ['C0BR48J5WG5'] })
		expect(screen.getAllByText('#maskin-app').length).toBeGreaterThan(0)
		await user.click(screen.getByRole('button', { name: /Add/i }))
		expect(await screen.findByText('#development')).toBeTruthy()
		expect(screen.getByText('#leadership')).toBeTruthy()
		expect(screen.getByText('private')).toBeTruthy()
	})

	it('saves the list with the channel added when a person checks it', async () => {
		const { user } = renderCard({ slack_direct_post_channels: ['C0BR48J5WG5'] })
		await user.click(screen.getByRole('button', { name: /Add/i }))
		await user.click(await screen.findByText('#development'))
		expect(save).toHaveBeenCalledWith(['C0BR48J5WG5', 'C06LC37JJCS'])
	})

	it('saves the list without the channel when a person unchecks it', async () => {
		const { user } = renderCard({ slack_direct_post_channels: ['C0BR48J5WG5', 'C06LC37JJCS'] })
		await user.click(screen.getByRole('button', { name: 'Remove #maskin-app' }))
		expect(save).toHaveBeenCalledWith(['C06LC37JJCS'])
	})

	it('is read-only for someone who is not an admin or owner', () => {
		mockRole.mockReturnValue('member')
		renderCard({ slack_direct_post_channels: ['C0BR48J5WG5'] })
		expect(screen.getByRole('button', { name: /Add/i }).hasAttribute('disabled')).toBe(true)
		expect(screen.getByText(/Only a workspace admin or owner/)).toBeTruthy()
	})

	it('is read-only for an agent even when the role is owner', () => {
		mockActor.mockReturnValue({ id: 'agent-1', type: 'agent' })
		renderCard()
		expect(screen.getByRole('button', { name: /Add/i }).hasAttribute('disabled')).toBe(true)
	})
})
