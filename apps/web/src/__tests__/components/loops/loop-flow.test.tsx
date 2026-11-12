import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

function wrapper() {
	return createWorkspaceWrapper({ id: 'ws-1', settings: {} })
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

		expect(await screen.findByRole('heading', { name: 'Pipeline' })).toBeInTheDocument()
		expect(screen.queryByText('The flow, right now')).not.toBeInTheDocument()
		expect(screen.queryByText(/triggers on/)).not.toBeInTheDocument()
	})

	it('draws one column per agent with its trigger cards', async () => {
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

		const pipeline = await screen.findByTestId('loop-pipeline')
		expect(within(pipeline).getByText('Relay')).toBeInTheDocument()
		expect(within(pipeline).getByText('Compass')).toBeInTheDocument()
		expect(within(pipeline).getByText('Normalises the Slack event')).toBeInTheDocument()
		expect(within(pipeline).getByText('Sweeps stuck insights nightly')).toBeInTheDocument()
		// A card is a link to the trigger's own page.
		expect(screen.getByRole('link', { name: /Normalises the Slack event/ })).toBeInTheDocument()
	})

	it('labels a cron trigger Schedule and anything else Event', async () => {
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

		expect(await screen.findByText('Schedule')).toBeInTheDocument()
		expect(screen.getByText('Event')).toBeInTheDocument()
	})

	it("orders the steps by the flow's trigger order, else A to Z", async () => {
		const names = () =>
			within(screen.getByTestId('loop-pipeline'))
				.getAllByRole('link', { name: /(Relay|Compass)$/ })
				.map((a) => a.textContent)

		const { unmount } = render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={[relayEvent, compassCron]}
				actors={[relay, compass]}
				loop={buildLoopSummary({ triggerIds: ['t-relay', 't-compass'] })}
			/>,
			{ wrapper: wrapper() },
		)
		// Each link starts with the agent's avatar initials.
		expect(names()).toEqual(['RERelay', 'COCompass'])
		unmount()

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
		expect(names()).toEqual(['COCompass', 'RERelay'])
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

	it('shows an agent the flow names but no trigger sets off, with "No trigger"', async () => {
		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={[relayEvent]}
				actors={[relay, compass]}
				loop={buildLoopSummary({ agentIds: ['relay', 'compass'], triggerIds: ['t-relay'] })}
			/>,
			{ wrapper: wrapper() },
		)

		expect(await screen.findByText('No trigger')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Compass$/ })).toBeInTheDocument()
	})

	it('filters the columns by agent from the chips', async () => {
		const user = userEvent.setup()
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

		expect(await screen.findByRole('button', { name: /All steps/ })).toHaveTextContent('2')
		await user.click(screen.getByRole('button', { name: /^Compass/ }))

		expect(screen.queryByText('Normalises the Slack event')).not.toBeInTheDocument()
		expect(screen.getByText('Sweeps stuck insights nightly')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: /All steps/ }))
		expect(screen.getByText('Normalises the Slack event')).toBeInTheDocument()
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

	it('keeps a very long agent name on one line in its chip', async () => {
		const longAgent = buildActorListItem({
			id: 'long',
			name: 'An agent with an extraordinarily long name that keeps going past any column',
			type: 'agent',
		})
		const t = buildTriggerResponse({ id: 't-l', targetActorId: 'long', type: 'event', config: {} })
		render(<LoopFlow workspaceId="ws-1" triggers={[relayEvent, t]} actors={[relay, longAgent]} />, {
			wrapper: wrapper(),
		})

		const chip = await screen.findByRole('button', { name: /An agent with an extraordinarily/ })
		expect(chip.className).toContain('max-w-full')
		expect(chip.querySelector('.truncate')).not.toBeNull()
	})
})
