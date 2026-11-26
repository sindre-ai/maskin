import { navigateToSearchRow } from '@/lib/search/open-row'
import { describe, expect, it, vi } from 'vitest'

describe('navigateToSearchRow', () => {
	it('opens a person on their own page', () => {
		const navigate = vi.fn()
		navigateToSearchRow(navigate as never, 'ws-1', { group: 'people', id: 'actor-1' })
		expect(navigate).toHaveBeenCalledWith({
			to: '/$workspaceId/people/$actorId',
			params: { workspaceId: 'ws-1', actorId: 'actor-1' },
		})
	})

	it('still opens an agent on its own page', () => {
		const navigate = vi.fn()
		navigateToSearchRow(navigate as never, 'ws-1', { group: 'agents', id: 'agent-1' })
		expect(navigate).toHaveBeenCalledWith({
			to: '/$workspaceId/agents/$agentId',
			params: { workspaceId: 'ws-1', agentId: 'agent-1' },
		})
	})
})
