import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		objects: { list: vi.fn() },
		actors: { list: vi.fn() },
	},
}))

import { FilterBar } from '@/components/work-board/filter-bar'
import { api } from '@/lib/api'
import { buildActorListItem, buildObjectResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const wrapper = () => createWorkspaceWrapper({ id: 'ws-1' })

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(api.objects.list).mockImplementation(async (_ws: string, filters) => {
		if (filters?.type === 'bet') {
			return [buildObjectResponse({ id: 'b1', type: 'bet', title: 'Ship X', status: 'active' })]
		}
		return []
	})
	vi.mocked(api.actors.list).mockResolvedValue([
		buildActorListItem({ id: 'a-1', type: 'human', name: 'Alice' }),
	])
})

describe('FilterBar', () => {
	it('renders chips for each active filter', async () => {
		const onChange = vi.fn()
		render(
			<FilterBar
				filters={{ bet: 'b1', assignee: 'mine', status: 'blocked' }}
				onChange={onChange}
			/>,
			{ wrapper: wrapper() },
		)
		// Wait for bets to load so the bet title chip can render with a real title.
		expect(await screen.findByText(/Bet:/i)).toBeInTheDocument()
		expect(screen.getByText(/Assignee: Mine/i)).toBeInTheDocument()
		expect(screen.getByText(/Status: Blocked/i)).toBeInTheDocument()
	})

	it('clicking a chip removes that single filter', async () => {
		const onChange = vi.fn()
		render(
			<FilterBar
				filters={{ bet: 'b1', assignee: 'mine', status: 'blocked' }}
				onChange={onChange}
			/>,
			{ wrapper: wrapper() },
		)
		const chip = await screen.findByLabelText(/Remove filter: Status: Blocked/i)
		fireEvent.click(chip)
		expect(onChange).toHaveBeenCalledWith({
			bet: 'b1',
			assignee: 'mine',
			status: undefined,
		})
	})

	it('renders no chips when no filters are active', () => {
		const onChange = vi.fn()
		render(<FilterBar filters={{}} onChange={onChange} />, { wrapper: wrapper() })
		expect(screen.queryByText(/Bet:/i)).not.toBeInTheDocument()
		expect(screen.queryByText(/Assignee:/i)).not.toBeInTheDocument()
		expect(screen.queryByText(/Status:/i)).not.toBeInTheDocument()
	})
})
