import { beforeEach, describe, expect, it, vi } from 'vitest'

const { trackFlowStep, trackFlowError } = vi.hoisted(() => ({
	trackFlowStep: vi.fn(),
	trackFlowError: vi.fn(),
}))
vi.mock('@/lib/analytics', () => ({
	newFlowId: () => 'flow-1',
	trackFlowStep,
	trackFlowError,
}))

import { createComputerViewFlow } from '@/lib/computer-view-flow'

const steps = () => trackFlowStep.mock.calls.map(([p]) => p.step)

beforeEach(() => {
	trackFlowStep.mockClear()
	trackFlowError.mockClear()
})

describe('createComputerViewFlow', () => {
	it('sends the mode changes in order, each with the one flow id, and says where it was opened from', () => {
		const flow = createComputerViewFlow('chat_request_card')

		flow.opened()
		flow.firstFrame(640)
		flow.takeOver(true)
		flow.takeOver(false)
		flow.closed()

		expect(steps()).toEqual([
			'view_opened',
			'first_frame',
			'take_over_started',
			'take_over_ended',
			'view_closed',
		])
		expect(trackFlowStep.mock.calls[0][0]).toEqual({
			flow: 'agent_computer',
			step: 'view_opened',
			flowId: 'flow-1',
			from: 'chat_request_card',
		})
		expect(trackFlowStep.mock.calls[1][0]).toMatchObject({ step: 'first_frame', durationMs: 640 })
		expect(trackFlowStep.mock.calls.every(([p]) => p.flowId === 'flow-1')).toBe(true)
	})

	it('sends nothing for a repeat of the same take-over state', () => {
		const flow = createComputerViewFlow('agent_page')

		flow.takeOver(false)
		flow.takeOver(true)
		flow.takeOver(true)

		expect(steps()).toEqual(['take_over_started'])
	})

	it('ends a take-over still running before it closes, and closes only once', () => {
		const flow = createComputerViewFlow('agent_page')

		flow.opened()
		flow.takeOver(true)
		flow.closed()
		flow.closed()
		// The viewer unmounting after the parent hands back again: nothing more.
		flow.takeOver(false)

		expect(steps()).toEqual(['view_opened', 'take_over_started', 'take_over_ended', 'view_closed'])
	})

	it('reports a lost connection as a flow_error at the step reached, with a fixed category', () => {
		const flow = createComputerViewFlow('chat_computers_pane')

		flow.connectionLost(false)
		flow.connectionLost(true)

		expect(trackFlowError.mock.calls).toEqual([
			[
				{
					flow: 'agent_computer',
					step: 'view_opened',
					flowId: 'flow-1',
					errorCategory: 'connection_lost',
				},
			],
			[
				{
					flow: 'agent_computer',
					step: 'first_frame',
					flowId: 'flow-1',
					errorCategory: 'connection_lost',
				},
			],
		])
	})
})
