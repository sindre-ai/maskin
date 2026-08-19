import { LoopActivity } from '@/components/loops/loop-activity'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		actors: { list: vi.fn(), get: vi.fn() },
		files: { list: vi.fn() },
	},
}))

import { api } from '@/lib/api'
import { buildActorListItem, buildEventResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const actor = buildActorListItem({ id: 'actor-1', name: 'Relay', type: 'agent' })

function renderActivity(props: {
	activityEvents?: Parameters<typeof LoopActivity>[0]['activityEvents']
	entityEvents?: Parameters<typeof LoopActivity>[0]['entityEvents']
}) {
	return render(
		<LoopActivity
			workspaceId="ws-1"
			loopId="loop-1"
			activityEvents={props.activityEvents}
			entityEvents={props.entityEvents}
		/>,
		{ wrapper: createWorkspaceWrapper() },
	)
}

describe('LoopActivity', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(api.actors.list).mockResolvedValue([actor])
		vi.mocked(api.actors.get).mockResolvedValue({ ...actor } as never)
		vi.mocked(api.files.list).mockResolvedValue([] as never)
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
		renderActivity({ activityEvents: events })

		expect(await screen.findByRole('region', { name: 'Activity' })).toBeInTheDocument()
		expect(screen.getByText(/completed session/)).toBeInTheDocument()
		expect(screen.getByText(/fired trigger/)).toBeInTheDocument()
	})

	it('reads comments posted on the loop into the same stream', async () => {
		const comment = buildEventResponse({
			id: 7,
			actorId: 'actor-1',
			action: 'commented',
			entityType: 'object',
			entityId: 'loop-1',
			createdAt: '2026-01-03T00:00:00Z',
			data: { content: 'Hold Acme out of the report' },
		})
		renderActivity({ entityEvents: [comment] })

		expect(await screen.findByText('Hold Acme out of the report')).toBeInTheDocument()
	})

	it('shows an empty state when nothing has happened yet', async () => {
		const events = [
			buildEventResponse({
				id: 1,
				actorId: 'actor-1',
				action: 'eligibility_check',
				entityType: 'x',
			}),
		]
		renderActivity({ activityEvents: events })

		expect(await screen.findByText('No activity yet.')).toBeInTheDocument()
	})

	it('does not surface loop-row change events (that feed the Changes log)', async () => {
		// A leaked `updated` / `status_changed` here would re-render the row the
		// Changes log already renders — the duplication this feed was split to avoid.
		const events = [
			buildEventResponse({
				id: 3,
				actorId: 'actor-1',
				action: 'updated',
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
		renderActivity({ activityEvents: events, entityEvents: events })

		expect(await screen.findByText(/completed session/)).toBeInTheDocument()
		expect(screen.queryByText(/updated/)).not.toBeInTheDocument()
	})

	it('folds everything past the three latest posts behind one pill', async () => {
		const user = userEvent.setup()
		const many = Array.from({ length: 8 }, (_, i) =>
			buildEventResponse({
				id: i + 1,
				actorId: 'actor-1',
				action: 'session_completed',
				entityType: 'object',
				entityId: `obj-${i}`,
				createdAt: `2026-01-0${i + 1}T00:00:00Z`,
			}),
		)
		renderActivity({ activityEvents: many })

		await user.click(await screen.findByRole('button', { name: /5 earlier posts in this loop/i }))
		expect(screen.getByRole('button', { name: /show less/i })).toBeInTheDocument()
	})
})
