import { LoopChanges } from '@/components/loops/loop-changes'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateMock = vi.fn()

vi.mock('@/lib/api', () => ({
	api: {
		actors: {
			list: vi.fn(),
		},
		objects: {
			update: (...args: unknown[]) => updateMock(...args),
		},
	},
}))

import { api } from '@/lib/api'
import { buildActorListItem, buildEventResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const actor = buildActorListItem({ id: 'actor-1', name: 'Relay', type: 'agent' })
const loopId = 'loop-1'

describe('LoopChanges', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(api.actors.list).mockResolvedValue([actor])
		updateMock.mockResolvedValue({ id: loopId, type: 'loop' })
	})

	it('lists a recent change with an Undo action', async () => {
		const events = [
			buildEventResponse({
				id: 1,
				entityId: loopId,
				actorId: 'actor-1',
				action: 'updated',
				entityType: 'bet',
				data: {
					changes: [
						{ field: 'status', old: 'draft', new: 'active' },
						{ field: 'title', old: 'Old title', new: 'New title' },
					],
				},
			}),
		]
		render(<LoopChanges workspaceId="ws-1" loopId={loopId} events={events} />, {
			wrapper: createWorkspaceWrapper(),
		})

		expect(await screen.findByText('Changes')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument()
	})

	it('reverts whitelisted fields when Undo is clicked', async () => {
		const user = userEvent.setup()
		const events = [
			buildEventResponse({
				id: 1,
				entityId: loopId,
				actorId: 'actor-1',
				action: 'status_changed',
				entityType: 'bet',
				data: {
					changes: [{ field: 'status', old: 'draft', new: 'active' }],
				},
			}),
		]
		render(<LoopChanges workspaceId="ws-1" loopId={loopId} events={events} />, {
			wrapper: createWorkspaceWrapper(),
		})

		await user.click(await screen.findByRole('button', { name: /undo/i }))
		expect(updateMock).toHaveBeenCalledWith(loopId, { status: 'draft' })
	})

	it('hides Undo when only server-managed fields changed', async () => {
		const events = [
			buildEventResponse({
				id: 1,
				entityId: loopId,
				actorId: 'actor-1',
				action: 'updated',
				entityType: 'bet',
				data: {
					changes: [{ field: 'activeSessionId', old: null, new: 'session-9' }],
				},
			}),
		]
		render(<LoopChanges workspaceId="ws-1" loopId={loopId} events={events} />, {
			wrapper: createWorkspaceWrapper(),
		})

		expect(await screen.findByText('Changes')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument()
	})

	it('renders nothing at all when there are no change events', () => {
		// v2 puts Changes inside the reader column above a sticky composer — an
		// empty section would push the composer down for no information.
		const { container } = render(<LoopChanges workspaceId="ws-1" loopId={loopId} events={[]} />, {
			wrapper: createWorkspaceWrapper(),
		})

		expect(container).toBeEmptyDOMElement()
	})

	it('renders each change as a chat bubble', async () => {
		const events = [
			buildEventResponse({
				id: 1,
				entityId: loopId,
				actorId: 'actor-1',
				action: 'updated',
				entityType: 'bet',
				data: { changes: [{ field: 'status', old: 'draft', new: 'active' }] },
			}),
		]
		render(<LoopChanges workspaceId="ws-1" loopId={loopId} events={events} />, {
			wrapper: createWorkspaceWrapper(),
		})

		expect(await screen.findByText('Changes')).toBeInTheDocument()
		// Agent-authored changes read as the left-hand bubble carrying the actor.
		const bubble = (await screen.findByText(/Relay/)).closest('p')
		expect(bubble?.className).toMatch(/rounded-2xl/)
	})
})
