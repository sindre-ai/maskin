import { LoopActivity } from '@/components/loops/loop-activity'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		actors: {
			list: vi.fn(),
		},
	},
}))

import { api } from '@/lib/api'
import { buildActorListItem, buildEventResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const actor = buildActorListItem({ id: 'actor-1', name: 'Relay', type: 'agent' })

describe('LoopActivity', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(api.actors.list).mockResolvedValue([actor])
	})

	it('renders agent work from matching events newest-first', async () => {
		const events = [
			buildEventResponse({
				id: 2,
				actorId: 'actor-1',
				action: 'session_completed',
				entityType: 'object',
				entityId: 'obj-9',
				createdAt: '2026-01-02T00:00:00Z',
			}),
			buildEventResponse({
				id: 1,
				actorId: 'actor-1',
				action: 'trigger_fired',
				entityType: 'trigger',
				entityId: 'trigger-1',
				createdAt: '2026-01-01T00:00:00Z',
			}),
		]
		render(<LoopActivity workspaceId="ws-1" events={events} />, {
			wrapper: createWorkspaceWrapper(),
		})

		expect(await screen.findByText('Latest activity')).toBeInTheDocument()
		expect(screen.getByText(/completed session/)).toBeInTheDocument()
		expect(screen.getByText(/fired trigger/)).toBeInTheDocument()
	})

	it('shows an empty state when no agent-work events match', async () => {
		const events = [
			buildEventResponse({
				id: 1,
				actorId: 'actor-1',
				action: 'eligibility_check',
				entityType: 'x',
			}),
		]
		render(<LoopActivity workspaceId="ws-1" events={events} />, {
			wrapper: createWorkspaceWrapper(),
		})

		expect(await screen.findByText('No activity yet.')).toBeInTheDocument()
	})

	it('does not surface loop-row change events (that feed the Changes log)', async () => {
		// If a leaked `updated` / `status_changed` reached this feed it would
		// re-render the same row the Changes log already renders — the exact
		// duplication this endpoint was split off to prevent.
		const events = [
			buildEventResponse({
				id: 3,
				actorId: 'actor-1',
				action: 'updated',
				entityType: 'object',
				entityId: 'loop-1',
			}),
			buildEventResponse({
				id: 2,
				actorId: 'actor-1',
				action: 'status_changed',
				entityType: 'object',
				entityId: 'loop-1',
			}),
			buildEventResponse({
				id: 1,
				actorId: 'actor-1',
				action: 'session_completed',
				entityType: 'session',
				entityId: 'session-1',
			}),
		]
		render(<LoopActivity workspaceId="ws-1" events={events} />, {
			wrapper: createWorkspaceWrapper(),
		})

		expect(await screen.findByText(/completed session/)).toBeInTheDocument()
		expect(screen.queryByText(/updated/)).not.toBeInTheDocument()
		expect(screen.queryByText(/changed status/)).not.toBeInTheDocument()
	})

	it('collapses a long feed behind a "See all activity" toggle', async () => {
		const user = userEvent.setup()
		const many = Array.from({ length: 8 }, (_, i) =>
			buildEventResponse({
				id: i + 1,
				actorId: 'actor-1',
				action: 'session_completed',
				entityType: 'object',
				entityId: `obj-${i}`,
			}),
		)
		render(<LoopActivity workspaceId="ws-1" events={many} />, {
			wrapper: createWorkspaceWrapper(),
		})

		await user.click(await screen.findByRole('button', { name: /see all activity/i }))
		expect(screen.getByRole('button', { name: /show less/i })).toBeInTheDocument()
	})
})
