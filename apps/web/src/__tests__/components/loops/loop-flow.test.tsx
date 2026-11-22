import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const updateMutate = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-triggers', () => ({
	useUpdateTrigger: () => ({ mutate: updateMutate, isPending: false }),
}))

import { LoopFlow } from '@/components/loops/loop-flow'
import { buildActorListItem, buildLoopSummary, buildTriggerResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const relay = buildActorListItem({ id: 'relay', name: 'Relay', type: 'agent' })
const compass = buildActorListItem({ id: 'compass', name: 'Compass', type: 'agent' })

const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'validated', 'done']

function wrapper() {
	return createWorkspaceWrapper({
		id: 'ws-1',
		settings: { statuses: { task: TASK_STATUSES, bet: ['opportunity', 'define', 'active'] } },
	})
}

function statusChange(id: string, toStatus: string, extra: Record<string, unknown> = {}) {
	return buildTriggerResponse({
		id,
		targetActorId: 'relay',
		type: 'event',
		name: `Fires on ${toStatus}`,
		config: { entity_type: 'task', action: 'status_changed', to_status: toStatus, ...extra },
	})
}

const relayEvent = buildTriggerResponse({
	id: 't-relay',
	targetActorId: 'relay',
	type: 'event',
	name: 'Normalises the Slack event',
	config: {},
})
const compassCron = buildTriggerResponse({
	id: 't-compass',
	targetActorId: 'compass',
	type: 'cron',
	name: 'Sweeps stuck insights nightly',
	config: { expression: '0 2 * * *' },
})

describe('LoopFlow', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('is headed "Pipeline" with no summary line under it', async () => {
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={[relayEvent, compassCron]}
				actors={[relay, compass]}
			/>,
			{
				wrapper: wrapper(),
			},
		)

		expect(await screen.findByRole('heading', { name: 'How it runs' })).toBeInTheDocument()
		expect(screen.queryByText('The flow, right now')).not.toBeInTheDocument()
		expect(screen.queryByText(/triggers on/)).not.toBeInTheDocument()
	})

	it('draws the task statuses left to right, with an arrow between each pair', async () => {
		render(
			<LoopFlow workspaceId="ws-1" triggers={[statusChange('t-1', 'todo')]} actors={[relay]} />,
			{
				wrapper: wrapper(),
			},
		)

		const row = await screen.findByTestId('loop-status-row-task')
		const boxes = TASK_STATUSES.map((status) =>
			within(row).getByTestId(`loop-status-task-${status}`),
		)
		expect(boxes.map((b) => b.querySelector('span')?.textContent)).toEqual([
			'Backlog',
			'To do',
			'In progress',
			'In review',
			'Validated',
			'Done',
		])
		expect(row.querySelectorAll('svg[aria-hidden]')).toHaveLength(TASK_STATUSES.length - 1)
	})

	it('places a trigger under the status it fires on, with the agent it wakes', async () => {
		const t = statusChange('t-1', 'in_review', { from_status: 'in_progress' })
		render(<LoopFlow workspaceId="ws-1" triggers={[t, relayEvent]} actors={[relay]} />, {
			wrapper: wrapper(),
		})

		const column = await screen.findByTestId('loop-status-task-in_review')
		expect(within(column).getByText('Fires on in_review')).toBeInTheDocument()
		expect(within(column).getByText('from in_progress')).toBeInTheDocument()
		expect(within(column).getByText('Relay')).toBeInTheDocument()
		// A card is a link to the trigger's own page.
		expect(screen.getByRole('link', { name: /Fires on in_review/ })).toBeInTheDocument()
		// The other statuses stay as empty boxes so the flow reads end to end.
		expect(within(screen.getByTestId('loop-status-task-done')).queryByRole('link')).toBeNull()
	})

	it('omits the from-status when the trigger fires from any status', async () => {
		render(
			<LoopFlow workspaceId="ws-1" triggers={[statusChange('t-1', 'todo')]} actors={[relay]} />,
			{
				wrapper: wrapper(),
			},
		)

		await screen.findByTestId('loop-status-task-todo')
		expect(screen.queryByText(/^from /)).not.toBeInTheDocument()
	})

	it('shows an unplaced event trigger and a schedule in their own strips', async () => {
		const created = buildTriggerResponse({
			id: 't-created',
			targetActorId: 'relay',
			type: 'event',
			name: 'Greets new tasks',
			config: { entity_type: 'task', action: 'created' },
		})
		const anyStatus = statusChange('t-any', '__any__')
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={[statusChange('t-1', 'todo'), created, anyStatus, compassCron]}
				actors={[relay, compass]}
			/>,
			{ wrapper: wrapper() },
		)

		const pipeline = await screen.findByTestId('loop-pipeline')
		const anyChange = screen.getByRole('heading', { name: 'Any change' })
			.parentElement as HTMLElement
		expect(within(anyChange).getByText('Greets new tasks')).toBeInTheDocument()
		expect(within(anyChange).getByText('Fires on __any__')).toBeInTheDocument()
		const schedule = screen.getByRole('heading', { name: 'Runs on a schedule' })
			.parentElement as HTMLElement
		expect(within(schedule).getByText('Sweeps stuck insights nightly')).toBeInTheDocument()
		expect(within(schedule).getByText('Compass')).toBeInTheDocument()
		// None of them sits under a status.
		expect(
			within(screen.getByTestId('loop-status-row-task')).queryByText('Greets new tasks'),
		).toBeNull()
		expect(pipeline).toBeInTheDocument()
	})

	it('puts a trigger whose status is not in the schema in the Any change strip, status shown', async () => {
		const gone = statusChange('t-gone', 'shipped')
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={[gone, statusChange('t-1', 'done')]}
				actors={[relay]}
			/>,
			{
				wrapper: wrapper(),
			},
		)

		const anyChange = (await screen.findByRole('heading', { name: 'Any change' }))
			.parentElement as HTMLElement
		expect(within(anyChange).getByText('Fires on shipped')).toBeInTheDocument()
		expect(within(anyChange).getByText('fires on shipped')).toBeInTheDocument()
		expect(
			within(screen.getByTestId('loop-status-row-task')).queryByText('Fires on shipped'),
		).toBeNull()
	})

	it('draws one labelled row per item type', async () => {
		const bet = buildTriggerResponse({
			id: 't-bet',
			targetActorId: 'compass',
			type: 'event',
			name: 'Shapes the bet',
			config: { entity_type: 'bet', action: 'status_changed', to_status: 'define' },
		})
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={[statusChange('t-1', 'todo'), bet]}
				actors={[relay, compass]}
			/>,
			{
				wrapper: wrapper(),
			},
		)

		expect(await screen.findByTestId('loop-status-row-task')).toBeInTheDocument()
		expect(screen.getByTestId('loop-status-row-bet')).toBeInTheDocument()
		expect(
			within(screen.getByTestId('loop-status-bet-define')).getByText('Shapes the bet'),
		).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'Bet' })).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'Task' })).toBeInTheDocument()
	})

	it("orders the cards in a status by the flow's trigger order, else A to Z", async () => {
		const first = statusChange('t-a', 'todo')
		const second = buildTriggerResponse({ ...first, id: 't-b', name: 'Aardvark' })
		const names = () =>
			within(screen.getByTestId('loop-status-task-todo'))
				.getAllByRole('link')
				.map((a) => a.textContent)

		const { unmount } = render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={[first, second]}
				actors={[relay]}
				loop={buildLoopSummary({ triggerIds: ['t-a', 't-b'] })}
			/>,
			{ wrapper: wrapper() },
		)
		expect(names()[0]).toContain('Fires on todo')
		unmount()

		render(<LoopFlow workspaceId="ws-1" triggers={[first, second]} actors={[relay]} />, {
			wrapper: wrapper(),
		})
		expect(names()[0]).toContain('Aardvark')
	})

	it('turns a trigger on or off from the card without opening it', async () => {
		render(<LoopFlow workspaceId="ws-1" triggers={[relayEvent]} actors={[relay]} />, {
			wrapper: wrapper(),
		})

		fireEvent.click(await screen.findByRole('switch', { name: /Pause Normalises the Slack event/ }))

		expect(updateMutate).toHaveBeenCalledWith(
			{ id: 't-relay', data: { enabled: false } },
			expect.anything(),
		)
	})

	it('dims a trigger that is off', async () => {
		const off = buildTriggerResponse({ ...relayEvent, id: 't-off', enabled: false })
		render(<LoopFlow workspaceId="ws-1" triggers={[off]} actors={[relay]} />, {
			wrapper: wrapper(),
		})

		const card = (await screen.findByRole('switch')).closest('div')
		expect(card?.className).toContain('opacity-55')
	})

	it('says the flow runs when asked when it has no triggers', async () => {
		render(<LoopFlow workspaceId="ws-1" triggers={[]} actors={[]} />, { wrapper: wrapper() })

		expect(await screen.findByText('This flow runs when you ask.')).toBeInTheDocument()
		expect(screen.queryByTestId('loop-pipeline')).not.toBeInTheDocument()
	})

	it('offers "+ Add trigger" only when the caller can add one', async () => {
		const onAdd = vi.fn()
		const { rerender } = render(<LoopFlow workspaceId="ws-1" triggers={[]} actors={[]} />, {
			wrapper: wrapper(),
		})
		expect(screen.queryByRole('button', { name: '+ Add trigger' })).not.toBeInTheDocument()

		rerender(<LoopFlow workspaceId="ws-1" triggers={[]} actors={[]} onAddTrigger={onAdd} />)
		fireEvent.click(screen.getByRole('button', { name: '+ Add trigger' }))
		expect(onAdd).toHaveBeenCalledTimes(1)
	})

	it('lets a long trigger name wrap inside its card', async () => {
		const long = buildTriggerResponse({
			id: 't-long',
			targetActorId: 'relay',
			type: 'event',
			name: 'A very long step description that must wrap cleanly https://example.com/a/extremely/long/unbroken/url/that/should/never/force/horizontal/overflow',
			config: {},
		})
		render(<LoopFlow workspaceId="ws-1" triggers={[long]} actors={[relay]} />, {
			wrapper: wrapper(),
		})

		const name = await screen.findByText(/A very long step description/)
		expect(name.classList.contains('min-w-0')).toBe(true)
		expect(name.classList.contains('break-words')).toBe(true)
	})

	it('gives every card a readable line: name, then what it asks the agent to do', async () => {
		const t = buildTriggerResponse({
			id: 't-a',
			targetActorId: 'relay',
			type: 'event',
			name: 'Weekday briefs',
			actionPrompt: 'The researcher drafts the five briefs.\nThen posts them.',
			config: { entity_type: 'task', action: 'created' },
		})
		render(<LoopFlow workspaceId="ws-1" triggers={[t]} actors={[relay]} />, { wrapper: wrapper() })

		expect(await screen.findByText('Weekday briefs')).toBeInTheDocument()
		expect(screen.getByText('The researcher drafts the five briefs.')).toBeInTheDocument()
		expect(screen.queryByText(/Then posts them/)).not.toBeInTheDocument()
	})

	it('falls back to the instruction, then to when it fires, never a blank or an id', async () => {
		const noName = buildTriggerResponse({
			id: 't-b',
			targetActorId: 'relay',
			type: 'event',
			name: '  ',
			actionPrompt: 'Sweep the stuck insights',
			config: { entity_type: 'insight', action: 'created' },
		})
		const bare = buildTriggerResponse({
			id: 't-c',
			targetActorId: 'compass',
			type: 'event',
			name: '',
			actionPrompt: '',
			config: { entity_type: 'task', action: 'created' },
		})
		render(<LoopFlow workspaceId="ws-1" triggers={[noName, bare]} actors={[relay, compass]} />, {
			wrapper: wrapper(),
		})

		expect(await screen.findByText('Sweep the stuck insights')).toBeInTheDocument()
		expect(screen.getByText('When task is created')).toBeInTheDocument()
		expect(screen.queryByText('t-b')).not.toBeInTheDocument()
	})
})
