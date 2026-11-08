import { buildFlowsBrief, failedAgentForLoop, loopNeedsYou } from '@/components/loops/loop-brief'
import type { SessionResponse } from '@/lib/api'
import { describe, expect, it } from 'vitest'

const loop = (over: Record<string, unknown> = {}) => ({
	id: 'l1',
	name: 'Product Delivery',
	pill: 'supervised' as const,
	waitingCount: 0,
	...over,
})

const session = (over: Partial<SessionResponse>) =>
	({
		id: 's',
		actorId: 'a1',
		status: 'failed',
		createdAt: '2026-01-01T00:00:00Z',
		...over,
	}) as SessionResponse

describe('buildFlowsBrief', () => {
	it('counts the flows that need you in one line', () => {
		const failed = { agent: { id: 'a1', name: 'Code Reviewer' }, session: session({}) }
		const brief = buildFlowsBrief(
			[
				loop(),
				loop({ id: 'l2', name: 'Sales', pill: 'waiting_on_you', waitingCount: 1 }),
				loop({ id: 'l3' }),
			],
			new Map([['l1', failed]]),
		)
		expect(brief.lead).toBe('2 of 3 flows need you.')
	})

	it('has no second line', () => {
		const brief = buildFlowsBrief([loop({ pill: 'waiting_on_you' })], new Map())
		expect(brief.lead).toBe('1 of 1 flow needs you.')
		expect(Object.keys(brief)).toEqual(['total', 'needYou', 'lead'])
	})

	it('says no flows need you when none do', () => {
		expect(buildFlowsBrief([loop()], new Map()).lead).toBe('No flows need you.')
	})
})

describe('failedAgentForLoop', () => {
	const actors = [{ id: 'a1', name: 'Code Reviewer' }]

	it('finds an agent whose newest run failed', () => {
		const found = failedAgentForLoop({ agentIds: ['a1'] }, [session({})], actors)
		expect(found?.agent.name).toBe('Code Reviewer')
		expect(loopNeedsYou({ pill: 'supervised' }, found)).toBe(true)
	})

	it('ignores a failure behind a newer success', () => {
		const sessions = [
			session({ id: 'old' }),
			session({ id: 'new', status: 'completed', createdAt: '2026-02-01T00:00:00Z' }),
		]
		expect(failedAgentForLoop({ agentIds: ['a1'] }, sessions, actors)).toBeNull()
	})
})
