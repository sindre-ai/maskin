import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			list: vi.fn(),
		},
		relationships: {
			list: vi.fn(),
		},
	},
}))

import { Board } from '@/components/work-board/board'
import { api } from '@/lib/api'
import { buildObjectResponse, type buildRelationshipResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const workspaceId = 'ws-1'

function setupApi({
	bets = [] as ReturnType<typeof buildObjectResponse>[],
	tasks = [] as ReturnType<typeof buildObjectResponse>[],
	rels = [] as ReturnType<typeof buildRelationshipResponse>[],
}) {
	vi.mocked(api.objects.list).mockImplementation(async (_ws: string, filters) => {
		if (filters?.type === 'bet') return bets
		if (filters?.type === 'task') return tasks
		return []
	})
	vi.mocked(api.relationships.list).mockResolvedValue(rels)
}

const wrapper = () =>
	createWorkspaceWrapper({
		id: workspaceId,
		settings: {
			statuses: {
				task: ['backlog', 'todo', 'in_progress', 'in_review', 'testing', 'done', 'blocked'],
			},
		},
	})

beforeEach(() => {
	vi.clearAllMocks()
})

describe('Board', () => {
	it('renders an empty state when there are no bets and no tasks', async () => {
		setupApi({})
		render(<Board />, { wrapper: wrapper() })

		expect(await screen.findByText('No bets or tasks yet')).toBeInTheDocument()
	})

	it('renders a swimlane for each bet plus a No-bet lane when orphans exist', async () => {
		const betA = buildObjectResponse({ id: 'bet-a', type: 'bet', status: 'active', title: 'Bet A' })
		const betB = buildObjectResponse({ id: 'bet-b', type: 'bet', status: 'active', title: 'Bet B' })
		const orphan = buildObjectResponse({ id: 't-o', type: 'task', status: 'todo', title: 'Orphan' })
		setupApi({ bets: [betA, betB], tasks: [orphan], rels: [] })

		render(<Board />, { wrapper: wrapper() })

		expect(await screen.findByText('Bet A')).toBeInTheDocument()
		expect(screen.getByText('Bet B')).toBeInTheDocument()
		expect(screen.getByText('No bet')).toBeInTheDocument()
	})

	it('shows error state when the underlying queries fail', async () => {
		vi.mocked(api.objects.list).mockRejectedValue(new Error('boom'))
		vi.mocked(api.relationships.list).mockRejectedValue(new Error('boom'))

		render(<Board />, { wrapper: wrapper() })

		expect(await screen.findByText('Could not load the board')).toBeInTheDocument()
	})
})
