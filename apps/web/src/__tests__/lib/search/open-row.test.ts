import { navigateToSearchRow } from '@/lib/search/open-row'
import { describe, expect, it, vi } from 'vitest'

describe('navigateToSearchRow', () => {
	it('opens a person on the members page with the member dialog param', () => {
		const navigate = vi.fn()
		navigateToSearchRow(navigate as never, 'ws-1', { group: 'people', id: 'actor-1' })
		expect(navigate).toHaveBeenCalledWith({
			to: '/$workspaceId/settings/members',
			params: { workspaceId: 'ws-1' },
			search: { member: 'actor-1' },
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
