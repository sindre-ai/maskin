import { buildPhases } from '@/components/activity/build-phases'
import { describe, expect, it } from 'vitest'
import { buildEventResponse, buildObjectResponse } from '../factories'

describe('buildPhases', () => {
	it('returns a single empty phase when there are no events', () => {
		const object = buildObjectResponse({ status: 'signal', createdAt: '2026-04-01T00:00:00Z' })
		const phases = buildPhases([], object)

		expect(phases).toHaveLength(1)
		expect(phases[0]).toMatchObject({
			status: 'signal',
			startedAt: '2026-04-01T00:00:00Z',
			events: [],
		})
	})

	it('keeps non-status events under the initial phase when status never changed', () => {
		const object = buildObjectResponse({ status: 'signal', createdAt: '2026-04-01T00:00:00Z' })
		const created = buildEventResponse({ action: 'created', createdAt: '2026-04-01T00:00:00Z' })
		const comment = buildEventResponse({ action: 'commented', createdAt: '2026-04-01T01:00:00Z' })

		const phases = buildPhases([created, comment], object)

		expect(phases).toHaveLength(1)
		expect(phases[0].status).toBe('signal')
		expect(phases[0].events).toEqual([created, comment])
	})

	it('opens a new phase per status change and seeds it with the transition event', () => {
		const object = buildObjectResponse({ status: 'active', createdAt: '2026-04-01T00:00:00Z' })
		const created = buildEventResponse({ action: 'created', createdAt: '2026-04-01T00:00:00Z' })
		const transition = buildEventResponse({
			action: 'status_changed',
			createdAt: '2026-04-02T09:00:00Z',
			data: { previous: { status: 'signal' }, updated: { status: 'active' } },
		})
		const comment = buildEventResponse({ action: 'commented', createdAt: '2026-04-02T10:00:00Z' })

		const phases = buildPhases([created, transition, comment], object)

		expect(phases).toHaveLength(2)
		expect(phases[0]).toMatchObject({ status: 'signal', events: [created] })
		expect(phases[1]).toMatchObject({
			status: 'active',
			startedAt: '2026-04-02T09:00:00Z',
			events: [transition, comment],
		})
	})

	it('creates a separate phase each time the status flips back and forth', () => {
		const object = buildObjectResponse({ status: 'signal', createdAt: '2026-04-01T00:00:00Z' })
		const toActive = buildEventResponse({
			action: 'status_changed',
			createdAt: '2026-04-02T00:00:00Z',
			data: { previous: { status: 'signal' }, updated: { status: 'active' } },
		})
		const backToSignal = buildEventResponse({
			action: 'status_changed',
			createdAt: '2026-04-03T00:00:00Z',
			data: { previous: { status: 'active' }, updated: { status: 'signal' } },
		})

		const phases = buildPhases([toActive, backToSignal], object)

		expect(phases).toHaveLength(3)
		expect(phases.map((p) => p.status)).toEqual(['signal', 'active', 'signal'])
		expect(phases[1].events).toEqual([toActive])
		expect(phases[2].events).toEqual([backToSignal])
	})

	it('falls back to the object status when the previous-status snapshot is missing', () => {
		const object = buildObjectResponse({ status: 'active', createdAt: '2026-04-01T00:00:00Z' })
		const orphan = buildEventResponse({
			action: 'status_changed',
			createdAt: '2026-04-02T00:00:00Z',
			data: null,
		})

		const phases = buildPhases([orphan], object)

		expect(phases).toHaveLength(2)
		expect(phases[0].status).toBe('active')
		expect(phases[1].status).toBe('active')
		expect(phases[1].events).toEqual([orphan])
	})
})
