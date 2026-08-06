import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		relationships: {
			list: vi.fn(),
		},
	},
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

import { LoopFlow } from '@/components/loops/loop-flow'
import type { RelationshipResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { buildActorListItem, buildObjectResponse, buildTriggerResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const relay = buildActorListItem({ id: 'relay', name: 'Relay', type: 'agent' })
const compass = buildActorListItem({ id: 'compass', name: 'Compass', type: 'agent' })

const insightNew = buildObjectResponse({
	id: 'i-new',
	type: 'insight',
	title: 'New insight',
	status: 'new',
})
const insightClustered = buildObjectResponse({
	id: 'i-clustered',
	type: 'insight',
	title: 'Slack images do not render inline',
	status: 'clustered',
})
const insightScored = buildObjectResponse({
	id: 'i-scored',
	type: 'insight',
	title: 'Setup confusion drives churn',
	status: 'scored',
})
const bet = buildObjectResponse({
	id: 'bet-1',
	type: 'bet',
	title: 'Inline attachments',
	status: 'active',
})
const task = buildObjectResponse({
	id: 'task-1',
	type: 'task',
	title: 'Fix upload path',
	status: 'todo',
})

const childObjects = [insightNew, insightClustered, insightScored, bet, task]

function wrapper() {
	return createWorkspaceWrapper({
		id: 'ws-1',
		settings: { statuses: { insight: ['new', 'processing', 'clustered', 'scored'] } },
	})
}

function relationshipsFor(objectId: string): RelationshipResponse[] {
	if (objectId === 'i-clustered') {
		return [
			{
				id: 'rel-1',
				sourceType: 'object',
				sourceId: 'i-clustered',
				targetType: 'object',
				targetId: 'bet-1',
				type: 'informs',
				createdBy: 'actor-1',
				createdAt: null,
			},
		]
	}
	return []
}

describe('LoopFlow', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(api.relationships.list).mockImplementation((_workspaceId, params) =>
			Promise.resolve(relationshipsFor(params?.object_id ?? '')),
		)
	})

	it('renders trigger and agent counts in the section header', async () => {
		const triggers = [
			buildTriggerResponse({ id: 't1', targetActorId: 'relay', type: 'event', config: {} }),
			buildTriggerResponse({ id: 't2', targetActorId: 'compass', type: 'cron', config: {} }),
		]
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={triggers}
				actors={[relay, compass]}
				childObjects={childObjects}
			/>,
			{ wrapper: wrapper() },
		)

		expect(await screen.findByText('2 triggers · 2 agents')).toBeInTheDocument()
	})

	it('groups an event trigger with no from_status under "Comes in"', async () => {
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'relay',
				type: 'event',
				actionPrompt: 'Normalises the Slack event into the shared source',
				config: {},
			}),
		]
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={triggers}
				actors={[relay]}
				childObjects={childObjects}
			/>,
			{ wrapper: wrapper() },
		)

		expect(await screen.findByText('Comes in')).toBeInTheDocument()
		expect(
			screen.getByText('Normalises the Slack event into the shared source'),
		).toBeInTheDocument()
	})

	it('places a cron trigger under "Runs alongside"', async () => {
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'compass',
				type: 'cron',
				actionPrompt: 'Sweeps stuck insights nightly',
				config: { expression: '0 2 * * *' },
			}),
		]
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={triggers}
				actors={[compass]}
				childObjects={childObjects}
			/>,
			{ wrapper: wrapper() },
		)

		expect(await screen.findByText('Runs alongside')).toBeInTheDocument()
		expect(screen.getByText('Sweeps stuck insights nightly')).toBeInTheDocument()
	})

	it('places an event trigger with a recognised from_status right after that stage', async () => {
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'compass',
				type: 'event',
				actionPrompt: 'Writes the generalisable version',
				config: { entity_type: 'object', action: 'updated', from_status: 'clustered' },
			}),
		]
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={triggers}
				actors={[compass]}
				childObjects={childObjects}
			/>,
			{ wrapper: wrapper() },
		)

		// This one is settled synchronously (columns are computed from props,
		// not an async board fetch), but the relationship-derived cards below
		// need an await, so wait for one of those first for a stable assertion.
		await screen.findByText('Slack images do not render inline')
		expect(screen.getByText('Writes the generalisable version')).toBeInTheDocument()
		expect(screen.queryByText('Comes in')).not.toBeInTheDocument()
	})

	it('renders a cycle card with companions for an object that has relationships', async () => {
		render(<LoopFlow workspaceId="ws-1" triggers={[]} actors={[]} childObjects={childObjects} />, {
			wrapper: wrapper(),
		})

		expect(await screen.findByText('Slack images do not render inline')).toBeInTheDocument()
		expect(screen.getByText('Inline attachments')).toBeInTheDocument()
	})

	it('does not render a card for an object with no relationships, only its stage count', async () => {
		render(<LoopFlow workspaceId="ws-1" triggers={[]} actors={[]} childObjects={childObjects} />, {
			wrapper: wrapper(),
		})

		await screen.findByText('Slack images do not render inline')
		expect(screen.queryByText('New insight')).not.toBeInTheDocument()
		expect(screen.queryByText('Setup confusion drives churn')).not.toBeInTheDocument()
		expect(screen.getAllByText('new')).toHaveLength(1)
	})

	it('filters step rows by agent without hiding stage cards', async () => {
		const user = userEvent.setup()
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'relay',
				type: 'event',
				actionPrompt: 'Relay step',
				config: {},
			}),
			buildTriggerResponse({
				id: 't2',
				targetActorId: 'compass',
				type: 'event',
				actionPrompt: 'Compass step',
				config: {},
			}),
		]
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={triggers}
				actors={[relay, compass]}
				childObjects={childObjects}
			/>,
			{ wrapper: wrapper() },
		)

		expect(await screen.findByText('Relay step')).toBeInTheDocument()
		expect(screen.getByText('Compass step')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: /compass/i }))

		expect(screen.queryByText('Relay step')).not.toBeInTheDocument()
		expect(screen.getByText('Compass step')).toBeInTheDocument()
		// Stage cards are unaffected by the agent filter.
		expect(await screen.findByText('Slack images do not render inline')).toBeInTheDocument()
	})

	it('renders nothing when there are no triggers and no child objects', () => {
		const { container } = render(
			<LoopFlow workspaceId="ws-1" triggers={[]} actors={[]} childObjects={[]} />,
			{ wrapper: wrapper() },
		)

		expect(container).toBeEmptyDOMElement()
	})
})
