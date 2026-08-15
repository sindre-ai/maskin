import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildObject } from '../factories'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: loopsRoutes } = await import('../../routes/loops')

const ACTOR_ID = 'test-actor-id'

function setup() {
	return createTestApp(loopsRoutes, '/api/loops', ACTOR_ID)
}

function bet(overrides?: Record<string, unknown>) {
	return buildObject({
		type: 'bet',
		status: 'succeeded',
		title: 'Cold-outbound bet',
		content: 'Reach 10 warm replies in 4 weeks',
		driver: randomUUID(),
		...overrides,
	})
}

function loopRow(overrides?: Record<string, unknown>) {
	return {
		...buildObject({ type: 'loop', status: 'pilot' }),
		...overrides,
	}
}

describe('POST /api/loops/promote-from-bet', () => {
	it('promotes a succeeded bet — new loop at status=pilot, driver carried forward, derived_from edge', async () => {
		const { app, mockResults, calls } = setup()
		const workspaceId = randomUUID()
		const driverId = randomUUID()
		const source = bet({ workspaceId, driver: driverId })
		const created = loopRow({ workspaceId, driver: driverId, title: source.title })

		mockResults.selectQueue = [[source]]
		mockResults.insertQueue = [[created], [{ id: randomUUID() }], [], [], []]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/loops/promote-from-bet',
				{ betId: source.id },
				{ 'x-workspace-id': workspaceId },
			),
		)

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.id).toBe(created.id)
		expect(body.type).toBe('loop')
		expect(body.status).toBe('pilot')
		expect(body.derivedFromBetId).toBe(source.id)

		const loopInsert = calls.inserts[0] as Record<string, unknown>
		expect(loopInsert).toMatchObject({
			workspaceId,
			type: 'loop',
			status: 'pilot',
			title: source.title,
			content: source.content,
			driver: driverId,
		})
		const meta = loopInsert.metadata as Record<string, unknown>
		expect(meta.promoted_from_bet_id).toBe(source.id)

		const edgeInsert = calls.inserts[1] as Record<string, unknown>
		expect(edgeInsert).toMatchObject({
			sourceType: 'object',
			sourceId: created.id,
			targetType: 'object',
			targetId: source.id,
			type: 'derived_from',
		})
	})

	it('applies request-body overrides for name, guarantee, and loop-owned outcome fields', async () => {
		const { app, mockResults, calls } = setup()
		const workspaceId = randomUUID()
		const source = bet({ workspaceId })
		const created = loopRow({ workspaceId })

		mockResults.selectQueue = [[source]]
		mockResults.insertQueue = [[created], [{ id: randomUUID() }], [], []]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/loops/promote-from-bet',
				{
					betId: source.id,
					name: 'Outbound loop',
					guarantee: 'Every warm reply gets a follow-up within 24h',
					outcomeMetric: 'replies_per_week',
					outcomeTarget: '10',
					killThreshold: 0.4,
					entryCondition: 'A new prospect enters the queue',
					closeCondition: 'A meeting is booked or 3 follow-ups sent',
					humanDecisionPoints: 1,
				},
				{ 'x-workspace-id': workspaceId },
			),
		)

		expect(res.status).toBe(201)
		const loopInsert = calls.inserts[0] as Record<string, unknown>
		expect(loopInsert.title).toBe('Outbound loop')
		expect(loopInsert.content).toBe('Every warm reply gets a follow-up within 24h')
		const meta = loopInsert.metadata as Record<string, unknown>
		expect(meta.outcome_metric).toBe('replies_per_week')
		expect(meta.outcome_target).toBe('10')
		expect(meta.kill_threshold).toBe(0.4)
		expect(meta.entry_condition).toBe('A new prospect enters the queue')
		expect(meta.close_condition).toBe('A meeting is booked or 3 follow-ups sent')
		expect(meta.human_decision_points).toBe(1)
	})

	it('404s when the bet id does not exist in this workspace', async () => {
		const { app, mockResults } = createTestApp(loopsRoutes, '/api/loops', ACTOR_ID)
		mockResults.selectQueue = [[]]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/loops/promote-from-bet',
				{ betId: randomUUID() },
				{ 'x-workspace-id': randomUUID() },
			),
		)
		expect(res.status).toBe(404)
	})

	it('409s when the bet is not in `succeeded` status', async () => {
		const { app, mockResults } = createTestApp(loopsRoutes, '/api/loops', ACTOR_ID)
		const source = bet({ status: 'active' })
		mockResults.selectQueue = [[source]]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/loops/promote-from-bet',
				{ betId: source.id },
				{ 'x-workspace-id': source.workspaceId },
			),
		)
		expect(res.status).toBe(409)
		const body = (await res.json()) as { error: { message: string } }
		expect(body.error.message).toContain('succeeded')
	})

	it('400s when body fails schema validation', async () => {
		const { app } = setup()
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/loops/promote-from-bet',
				{ betId: 'not-a-uuid' },
				{ 'x-workspace-id': randomUUID() },
			),
		)
		expect(res.status).toBe(400)
	})
})
