import { LoopSteps } from '@/components/loops/loop-steps'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { buildActorListItem, buildTriggerResponse } from '../../factories'

describe('LoopSteps', () => {
	it('renders the trigger/agent count header and one row per trigger', () => {
		const relay = buildActorListItem({ id: 'relay', name: 'Relay', type: 'agent' })
		const compass = buildActorListItem({ id: 'compass', name: 'Compass', type: 'agent' })
		const triggers = [
			buildTriggerResponse({
				id: 't1',
				targetActorId: 'relay',
				actionPrompt: 'Normalises the Slack event into the shared source',
			}),
			buildTriggerResponse({
				id: 't2',
				targetActorId: 'compass',
				actionPrompt: 'Triages and clusters every insight',
			}),
		]

		render(
			<LoopSteps triggers={triggers} actors={[relay, compass]} triggerCount={2} agentCount={2} />,
		)

		expect(screen.getByText('2 triggers · 2 agents')).toBeInTheDocument()
		expect(screen.getAllByText('Relay')).not.toHaveLength(0)
		expect(
			screen.getByText('Normalises the Slack event into the shared source'),
		).toBeInTheDocument()
		expect(screen.getByText('Triages and clusters every insight')).toBeInTheDocument()
	})

	it('shows an "off" badge for disabled triggers', () => {
		const relay = buildActorListItem({ id: 'relay', name: 'Relay', type: 'agent' })
		const triggers = [buildTriggerResponse({ id: 't1', targetActorId: 'relay', enabled: false })]

		render(<LoopSteps triggers={triggers} actors={[relay]} triggerCount={1} agentCount={1} />)

		expect(screen.getByText('off')).toBeInTheDocument()
	})

	it('filters the step list by agent when a filter pill is clicked', async () => {
		const user = userEvent.setup()
		const relay = buildActorListItem({ id: 'relay', name: 'Relay', type: 'agent' })
		const compass = buildActorListItem({ id: 'compass', name: 'Compass', type: 'agent' })
		const triggers = [
			buildTriggerResponse({ id: 't1', targetActorId: 'relay', actionPrompt: 'Relay step' }),
			buildTriggerResponse({ id: 't2', targetActorId: 'compass', actionPrompt: 'Compass step' }),
		]

		render(
			<LoopSteps triggers={triggers} actors={[relay, compass]} triggerCount={2} agentCount={2} />,
		)

		expect(screen.getByText('Relay step')).toBeInTheDocument()
		expect(screen.getByText('Compass step')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: /compass/i }))

		expect(screen.queryByText('Relay step')).not.toBeInTheDocument()
		expect(screen.getByText('Compass step')).toBeInTheDocument()
	})

	it('renders an empty-filter message when no trigger is passed in', () => {
		render(<LoopSteps triggers={[]} actors={[]} triggerCount={0} agentCount={0} />)

		expect(screen.getByText('No step matches that filter.')).toBeInTheDocument()
	})
})
