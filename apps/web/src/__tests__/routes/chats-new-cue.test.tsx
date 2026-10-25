import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const flag = vi.hoisted(() => ({ on: true }))
const mockSearch = vi.fn(() => ({}) as Record<string, string | undefined>)
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useSearch: () => mockSearch(),
		}),
		useSearch: () => mockSearch(),
		useNavigate: () => vi.fn(),
	}
})

vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => flag.on }))
vi.mock('@/hooks/use-conversations', () => ({
	useCreateConversation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useConversationsInfinite: () => ({ data: undefined }),
}))

const FORGE = { id: 'forge-1', name: 'Forge', type: 'agent', description: 'Ships fixes' }
const SENTINEL = { id: 'sentinel-1', name: 'Sentinel', type: 'agent', description: 'Watches' }
const SAM = { actorId: 'sam-1', name: 'Sam', type: 'human', role: 'member' }
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [FORGE, SENTINEL] }),
	useDefaultChatAgent: () => undefined,
}))
vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: () => ({ data: [SAM] }),
}))
vi.mock('@/hooks/use-objects', () => ({ useObjects: () => ({ data: undefined }) }))
vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }))
vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: { settings: {} } }),
}))
vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'me-1', name: 'You', type: 'human' }),
}))
vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: () => null,
	trackChatSessionStarted: vi.fn(),
}))

// The composer's own behaviour is covered elsewhere; this route owes it a placeholder and a hint.
vi.mock('@/components/chat/chat', () => ({
	Composer: ({
		textareaLabel,
		placeholder,
		hint,
	}: { textareaLabel: string; placeholder: string; hint?: string | null }) => (
		<div>
			<textarea aria-label={textareaLabel} placeholder={placeholder} />
			{hint ? <p>{hint}</p> : null}
		</div>
	),
}))

import { Route } from '@/routes/_authed/$workspaceId/chats/new'

const NewChatPage = (Route as unknown as { component: React.FC }).component
const box = () => screen.getByLabelText('Message this conversation')

async function addRecipient(user: ReturnType<typeof userEvent.setup>, name: string) {
	await user.type(screen.getByLabelText('Add recipients'), `${name}{Enter}`)
	await screen.findByLabelText(`Remove ${name}`)
}

describe('New chat — group-chat cue', () => {
	beforeEach(() => {
		flag.on = true
		mockSearch.mockReturnValue({})
	})

	it('says nobody will answer after picking two agents, with no tag', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await addRecipient(user, 'Forge')
		await addRecipient(user, 'Sentinel')

		expect(box()).toHaveAttribute('placeholder', 'Message this conversation')
		expect(screen.getByText('No agent will reply. Tag one with @.')).toBeInTheDocument()
	})

	it('names the agent when the other participants are people and there is exactly one agent', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await addRecipient(user, 'Forge')
		await addRecipient(user, 'Sam')

		expect(box()).toHaveAttribute('placeholder', 'Reply to Forge…')
		expect(screen.queryByText(/No agent will reply/)).not.toBeInTheDocument()
	})

	it('keeps today’s placeholder with one recipient', async () => {
		const user = userEvent.setup()
		render(<NewChatPage />)
		await addRecipient(user, 'Forge')

		expect(box()).toHaveAttribute('placeholder', 'Message Forge…')
		expect(screen.queryByText(/No agent will reply/)).not.toBeInTheDocument()
	})

	it('keeps today’s placeholder and adds no hint when the flag is off', async () => {
		flag.on = false
		const user = userEvent.setup()
		render(<NewChatPage />)
		await addRecipient(user, 'Forge')
		await addRecipient(user, 'Sentinel')

		expect(box()).toHaveAttribute('placeholder', 'Message… / reference or create · @ mention')
		expect(screen.queryByText(/No agent will reply/)).not.toBeInTheDocument()
	})
})
