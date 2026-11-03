import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

import { LoopFlow } from '@/components/loops/loop-flow'
import {
	buildActorListItem,
	buildLoopSummary,
	buildObjectResponse,
	buildTriggerResponse,
} from '../../factories'
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

describe('LoopFlow', () => {
	beforeEach(() => {
		vi.clearAllMocks()
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

		// One note line: primitives · triggers on · agents (mockup 1891).
		expect(
			await screen.findByText(/3 object types · 2 of 2 triggers on · 2 agents/),
		).toBeInTheDocument()
	})

	it('groups an event trigger under "Event-based"', async () => {
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'relay',
				type: 'event',
				name: 'Normalises the Slack event into the shared source',
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

		expect(await screen.findByText('Triggers')).toBeInTheDocument()
		expect(screen.getByText('Event-based')).toBeInTheDocument()
		expect(
			screen.getByText('Normalises the Slack event into the shared source'),
		).toBeInTheDocument()
	})

	it('places a cron trigger under "Routines"', async () => {
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'compass',
				type: 'cron',
				name: 'Sweeps stuck insights nightly',
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

		expect(await screen.findByText('Routines')).toBeInTheDocument()
		expect(screen.getByText('Sweeps stuck insights nightly')).toBeInTheDocument()
	})

	it('puts a status-move trigger under the status it moves into, in status order', async () => {
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'compass',
				type: 'event',
				name: 'Scores the cluster',
				config: { entity_type: 'insight', action: 'updated', to_status: 'scored' },
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

		const step = await screen.findByText('Scores the cluster')
		const clustered = screen.getByText('clustered')
		const scored = screen.getByText('scored')
		// Statuses run in order, and the trigger lands after the status it targets.
		expect(
			clustered.compareDocumentPosition(scored) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy()
		expect(scored.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		// It is mapped to a status, so it is not repeated in the plain list.
		expect(screen.queryByText('Event-based')).not.toBeInTheDocument()
		expect(screen.queryByText('Triggers')).not.toBeInTheDocument()
	})

	it('puts a trigger with only a from_status under the status it leaves', async () => {
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'compass',
				type: 'event',
				name: 'Writes the generalisable version',
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

		const step = await screen.findByText('Writes the generalisable version')
		const clustered = screen.getByText('clustered')
		const scored = screen.getByText('scored')
		expect(clustered.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(step.compareDocumentPosition(scored) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it('puts a "created" trigger under the first status', async () => {
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'relay',
				type: 'event',
				name: 'Folds new knowledge into the wiki',
				config: { entity_type: 'insight', action: 'created' },
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

		const step = await screen.findByText('Folds new knowledge into the wiki')
		const first = screen.getByText('new')
		const second = screen.getByText('processing')
		expect(first.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(step.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(screen.queryByText('Event-based')).not.toBeInTheDocument()
	})

	it('shows the statuses of the type the triggers listen to, not the most linked type', async () => {
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'relay',
				type: 'event',
				name: 'Folds new knowledge into the wiki',
				config: { entity_type: 'knowledge', action: 'created' },
			}),
		]
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={triggers}
				actors={[relay]}
				childObjects={childObjects}
			/>,
			{
				wrapper: createWorkspaceWrapper({
					id: 'ws-1',
					settings: {
						statuses: {
							insight: ['new', 'processing'],
							knowledge: ['draft', 'validated', 'deprecated'],
						},
					},
				}),
			},
		)

		expect(await screen.findByText('draft')).toBeInTheDocument()
		expect(screen.getByText('deprecated')).toBeInTheDocument()
		expect(screen.queryByText('processing')).not.toBeInTheDocument()
	})

	it('keeps a trigger for another object type out of the status columns', async () => {
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'relay',
				type: 'event',
				name: 'Starts the task',
				config: { entity_type: 'task', to_status: 'scored' },
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

		expect(await screen.findByText('Event-based')).toBeInTheDocument()
		expect(screen.getByText('Starts the task')).toBeInTheDocument()
	})

	it('draws an arrow between each pair of statuses', async () => {
		const { container } = render(
			<LoopFlow workspaceId="ws-1" triggers={[]} actors={[]} childObjects={childObjects} />,
			{ wrapper: wrapper() },
		)

		await screen.findByText('clustered')
		// 4 statuses -> 3 gaps, each with a down (mobile) and a right (md+) arrow.
		expect(container.querySelectorAll('svg.lucide-arrow-right')).toHaveLength(3)
		expect(container.querySelectorAll('svg.lucide-arrow-down')).toHaveLength(3)
	})

	it('shows each stage with its count and no object cards', async () => {
		render(<LoopFlow workspaceId="ws-1" triggers={[]} actors={[]} childObjects={childObjects} />, {
			wrapper: wrapper(),
		})

		expect(await screen.findByText('clustered')).toBeInTheDocument()
		expect(screen.queryByText('Slack images do not render inline')).not.toBeInTheDocument()
		expect(screen.queryByText('Inline attachments')).not.toBeInTheDocument()
	})

	it('filters step rows by agent without hiding stages', async () => {
		const user = userEvent.setup()
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'relay',
				type: 'event',
				name: 'Relay step',
				config: {},
			}),
			buildTriggerResponse({
				id: 't2',
				targetActorId: 'compass',
				type: 'event',
				name: 'Compass step',
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
		// Stages are unaffected by the agent filter.
		expect(await screen.findByText('clustered')).toBeInTheDocument()
	})

	it('renders nothing when there are no triggers and no child objects', () => {
		const { container } = render(
			<LoopFlow workspaceId="ws-1" triggers={[]} actors={[]} childObjects={[]} />,
			{ wrapper: wrapper() },
		)

		expect(container).toBeEmptyDOMElement()
	})

	it('wraps a step description inside its container at mobile widths', async () => {
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'relay',
				type: 'event',
				name: 'A very long step description that must wrap cleanly instead of spilling past the container on a narrow mobile viewport https://example.com/a/extremely/long/unbroken/url/that/should/never/force/horizontal/overflow',
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

		const description = await screen.findByText(/A very long step description/)
		expect(description).toBeInTheDocument()
		// The description column must be allowed to shrink (min-w-0) and break
		// unbreakable tokens (break-words) so nothing overflows horizontally.
		const container = description.closest('.min-w-0')
		expect(container?.classList.contains('min-w-0')).toBe(true)
		expect(container?.classList.contains('break-words')).toBe(true)
	})

	it('includes the object-type count in the section note', async () => {
		render(<LoopFlow workspaceId="ws-1" triggers={[]} actors={[]} childObjects={childObjects} />, {
			wrapper: wrapper(),
		})

		expect(await screen.findByText(/3 object types/)).toBeInTheDocument()
	})

	it('renders a cycles note from the loop summary', async () => {
		const loop = buildLoopSummary({
			inProgressCount: 2,
			closedCount: 4,
			medianTimeToCloseMs: 2 * 24 * 60 * 60 * 1000,
		})
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={[]}
				actors={[]}
				childObjects={childObjects}
				loop={loop}
			/>,
			{ wrapper: wrapper() },
		)

		expect(await screen.findByText(/2 cycles are running/)).toBeInTheDocument()
		expect(screen.getByText(/4 cycles have closed/)).toBeInTheDocument()
		expect(screen.getByText(/median close 2d/)).toBeInTheDocument()
	})

	it('flags steps with "asks you" when the loop is waiting on the viewer', async () => {
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'relay',
				type: 'event',
				name: 'A step asking for input',
				config: {},
			}),
		]
		const loop = buildLoopSummary({ pill: 'waiting_on_you' })
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={triggers}
				actors={[relay]}
				childObjects={childObjects}
				loop={loop}
			/>,
			{ wrapper: wrapper() },
		)

		expect(await screen.findByText('asks you')).toBeInTheDocument()
	})
})
