import { MessageActivity } from '@/components/chat/message-activity'
import { ThreadComposer } from '@/components/chat/thread-composer'
import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useConversation: () => ({ data: undefined }),
	useConversationMessages: () => ({ data: undefined, hasNextPage: false }),
	flattenMessagesOldestFirst: () => [],
}))

vi.mock('@/hooks/use-actors', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-actors')>('@/hooks/use-actors')
	return {
		...actual,
		useActors: () => ({ data: [] }),
		useActor: () => ({ data: buildActorResponse({ name: 'Workspace Coach', type: 'agent' }) }),
	}
})

vi.mock('@/hooks/use-sessions', () => ({
	useActiveSessionsForConversation: () => ({ data: [] }),
	useSession: () => ({ data: undefined }),
	useStopSession: () => ({ mutate: vi.fn(), isPending: false }),
}))

const viewer = () => createWorkspaceWrapper({ role: 'viewer' })
const member = () => createWorkspaceWrapper({ role: 'member' })

const liveTurn: MessageTurnActivity = {
	sessionId: 'sess-1',
	actorId: 'agent-1',
	steps: [],
	inProgress: true,
}

describe('viewer fixture: chat composer and Stop', () => {
	it('switches the composer off and says why', () => {
		render(<ThreadComposer workspaceId="ws-1" conversationId="convo-1" />, { wrapper: viewer() })
		const box = screen.getByLabelText('Message this conversation')
		expect(box).toBeDisabled()
		expect(box).toHaveAttribute('placeholder', 'Viewers can read but not change this')
		expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Attach file' })).toBeDisabled()
	})

	it('disables Stop on a live agent turn', () => {
		render(<MessageActivity workspaceId="ws-1" turn={liveTurn} />, { wrapper: viewer() })
		expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled()
	})
})

describe('member fixture: chat composer and Stop stay as they were', () => {
	it('keeps the composer usable', () => {
		render(<ThreadComposer workspaceId="ws-1" conversationId="convo-1" />, { wrapper: member() })
		expect(screen.getByLabelText('Message this conversation')).toBeEnabled()
		expect(screen.getByRole('button', { name: 'Attach file' })).toBeEnabled()
	})

	it('keeps Stop enabled on a live agent turn', () => {
		render(<MessageActivity workspaceId="ws-1" turn={liveTurn} />, { wrapper: member() })
		expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
	})
})
