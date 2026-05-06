import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		actors: { list: vi.fn() },
	},
}))

import { AssigneeStack } from '@/components/work-board/assignee-stack'
import { api } from '@/lib/api'
import { buildActorListItem } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const wrapper = () => createWorkspaceWrapper({ id: 'ws-1' })

beforeEach(() => {
	vi.clearAllMocks()
})

describe('AssigneeStack', () => {
	it('renders nothing when there are no assignees (the 0-assignee case)', () => {
		vi.mocked(api.actors.list).mockResolvedValue([])
		const { container } = render(<AssigneeStack actorIds={[]} />, { wrapper: wrapper() })
		expect(container.firstChild).toBeNull()
	})

	it('renders a single avatar for one assignee', async () => {
		vi.mocked(api.actors.list).mockResolvedValue([
			buildActorListItem({ id: 'h-1', name: 'Sebastian', type: 'human' }),
		])
		render(<AssigneeStack actorIds={['h-1']} />, { wrapper: wrapper() })
		// Wait for actors query to resolve so titles are populated.
		expect(await screen.findByTitle('Sebastian')).toBeInTheDocument()
		expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
	})

	it('renders all 3 avatars without overflow when at the cap', async () => {
		vi.mocked(api.actors.list).mockResolvedValue([
			buildActorListItem({ id: 'h-1', name: 'Sebastian', type: 'human' }),
			buildActorListItem({ id: 'a-1', name: 'Magnus', type: 'agent' }),
			buildActorListItem({ id: 'h-2', name: 'Ada', type: 'human' }),
		])
		render(<AssigneeStack actorIds={['h-1', 'a-1', 'h-2']} />, { wrapper: wrapper() })
		expect(await screen.findByTitle('Sebastian')).toBeInTheDocument()
		expect(screen.getByTitle('Magnus')).toBeInTheDocument()
		expect(screen.getByTitle('Ada')).toBeInTheDocument()
		expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
	})

	it('truncates to 3 visible avatars + "+2" overflow chip when given 5 assignees', async () => {
		vi.mocked(api.actors.list).mockResolvedValue([
			buildActorListItem({ id: 'h-1', name: 'Alex', type: 'human' }),
			buildActorListItem({ id: 'h-2', name: 'Bea', type: 'human' }),
			buildActorListItem({ id: 'h-3', name: 'Cris', type: 'human' }),
			buildActorListItem({ id: 'h-4', name: 'Dax', type: 'human' }),
			buildActorListItem({ id: 'h-5', name: 'Eli', type: 'human' }),
		])
		render(<AssigneeStack actorIds={['h-1', 'h-2', 'h-3', 'h-4', 'h-5']} />, {
			wrapper: wrapper(),
		})
		expect(await screen.findByTitle('Alex')).toBeInTheDocument()
		expect(screen.getByTitle('Bea')).toBeInTheDocument()
		expect(screen.getByTitle('Cris')).toBeInTheDocument()
		expect(screen.queryByTitle('Dax')).not.toBeInTheDocument()
		expect(screen.queryByTitle('Eli')).not.toBeInTheDocument()
		expect(screen.getByText('+2')).toBeInTheDocument()
	})

	it('renders a pulsing dot only on agent avatars whose session is running', async () => {
		vi.mocked(api.actors.list).mockResolvedValue([
			buildActorListItem({ id: 'a-1', name: 'WorkingAgent', type: 'agent' }),
			buildActorListItem({ id: 'a-2', name: 'IdleAgent', type: 'agent' }),
			buildActorListItem({ id: 'h-1', name: 'WorkingHuman', type: 'human' }),
		])
		render(
			<AssigneeStack actorIds={['a-1', 'a-2', 'h-1']} runningAgentIds={new Set(['a-1', 'h-1'])} />,
			{ wrapper: wrapper() },
		)
		await screen.findByTitle('WorkingAgent')
		const dots = screen.queryAllByTestId('assignee-pulse-dot')
		expect(dots).toHaveLength(1)
		// The dot's aria-label points back to the running agent — never the idle
		// agent and never the human (humans don't have sessions in our model).
		expect(dots[0]).toHaveAttribute('aria-label', expect.stringContaining('WorkingAgent'))
	})

	it('invokes onAssigneeClick when an avatar button is clicked and stops propagation', async () => {
		vi.mocked(api.actors.list).mockResolvedValue([
			buildActorListItem({ id: 'h-1', name: 'Sebastian', type: 'human' }),
		])
		const onAssigneeClick = vi.fn()
		const onParentClick = vi.fn()
		render(
			// biome-ignore lint/a11y/useKeyWithClickEvents: test-only host element for stopPropagation assertion.
			<div onClick={onParentClick}>
				<AssigneeStack actorIds={['h-1']} onAssigneeClick={onAssigneeClick} />
			</div>,
			{ wrapper: wrapper() },
		)
		const button = await screen.findByRole('button', { name: 'Filter board to Sebastian' })
		button.click()
		expect(onAssigneeClick).toHaveBeenCalledWith('h-1')
		expect(onParentClick).not.toHaveBeenCalled()
	})

	it('falls back to a neutral "Unknown" treatment for actor IDs not in the directory', async () => {
		vi.mocked(api.actors.list).mockResolvedValue([])
		render(<AssigneeStack actorIds={['ghost']} />, { wrapper: wrapper() })
		// No assertion on order of resolution — just that the chip exists.
		const chip = await screen.findByTitle('Unknown')
		expect(within(chip).getByText('U')).toBeInTheDocument()
	})
})
