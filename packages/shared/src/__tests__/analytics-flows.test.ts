import { describe, expect, it } from 'vitest'
import {
	FLOW_ERROR_CATEGORIES,
	FLOW_STEPS,
	buildFlowErrorProps,
	buildFlowStepProps,
	createFlowClock,
	isFlowStep,
} from '../analytics-flows'

describe('FLOW_STEPS', () => {
	it('has no repeated step within a flow', () => {
		for (const steps of Object.values(FLOW_STEPS)) {
			expect(new Set(steps).size).toBe(steps.length)
		}
	})
})

describe('integration_connect', () => {
	it('has the four connect steps, in order, and carries the provider when given', () => {
		expect(FLOW_STEPS.integration_connect).toEqual([
			'connect_started',
			'redirected_out',
			'returned',
			'connected',
		])
		const base = {
			flow: 'integration_connect',
			step: 'returned',
			flowId: 'f1',
			surface: 'backend' as const,
		}
		expect(buildFlowStepProps({ ...base, durationMs: 3, provider: 'notion' })?.provider).toBe(
			'notion',
		)
		expect(
			buildFlowErrorProps({ ...base, errorCategory: 'timeout', provider: 'notion' })?.provider,
		).toBe('notion')
	})

	it('leaves the provider key out when none is given', () => {
		const props = buildFlowStepProps({
			flow: 'integration_connect',
			step: 'returned',
			flowId: 'f1',
			surface: 'backend',
			durationMs: null,
		})
		expect(props).not.toHaveProperty('provider')
	})
})

describe('buildFlowStepProps', () => {
	it('returns exactly flow, step, flow_id, surface and duration_ms', () => {
		expect(
			buildFlowStepProps({
				flow: 'agent_computer',
				step: 'view_opened',
				flowId: 'f1',
				surface: 'web',
				durationMs: null,
			}),
		).toEqual({
			flow: 'agent_computer',
			step: 'view_opened',
			flow_id: 'f1',
			surface: 'web',
			duration_ms: null,
		})
	})

	it('drops a step that is not in the vocabulary, or has no flow_id', () => {
		const base = { surface: 'web' as const, durationMs: 5 }
		expect(
			buildFlowStepProps({ ...base, flow: 'nope', step: 'view_opened', flowId: 'f1' }),
		).toBeNull()
		expect(
			buildFlowStepProps({ ...base, flow: 'agent_computer', step: 'first_launch', flowId: 'f1' }),
		).toBeNull()
		expect(
			buildFlowStepProps({ ...base, flow: 'agent_computer', step: 'view_opened', flowId: '' }),
		).toBeNull()
	})
})

describe('buildFlowErrorProps', () => {
	const base = {
		flow: 'agent_computer',
		step: 'view_opened',
		flowId: 'f1',
		surface: 'backend' as const,
	}

	it('returns exactly flow, step, flow_id, surface and error_category', () => {
		expect(buildFlowErrorProps({ ...base, errorCategory: 'timeout' })).toEqual({
			flow: 'agent_computer',
			step: 'view_opened',
			flow_id: 'f1',
			surface: 'backend',
			error_category: 'timeout',
		})
	})

	it('sends anything outside the fixed list as unknown, so message text never goes out', () => {
		const props = buildFlowErrorProps({
			...base,
			errorCategory: 'Cannot read secret of alice@x.com',
		})
		expect(props?.error_category).toBe('unknown')
		expect(FLOW_ERROR_CATEGORIES).toContain('unknown')
	})

	it('drops an unknown step', () => {
		expect(buildFlowErrorProps({ ...base, step: 'nope', errorCategory: 'timeout' })).toBeNull()
	})
})

describe('isFlowStep', () => {
	it('is false for a prototype key used as a flow', () => {
		expect(isFlowStep('toString', 'x')).toBe(false)
	})
})

describe('createFlowClock', () => {
	it('is null on the first tick and the gap since the previous one after that, per flow_id', () => {
		let t = 1000
		const clock = createFlowClock(() => t)
		expect(clock.tick('a')).toBeNull()
		t = 1400
		expect(clock.tick('a')).toBe(400)
		expect(clock.tick('b')).toBeNull()
		t = 1500
		expect(clock.tick('a')).toBe(100)
	})

	it('forgets the oldest flow_ids past its cap', () => {
		const clock = createFlowClock(() => 1)
		for (let i = 0; i < 501; i++) clock.tick(`f${i}`)
		expect(clock.tick('f0')).toBeNull()
		expect(clock.tick('f500')).toBe(0)
	})
})
