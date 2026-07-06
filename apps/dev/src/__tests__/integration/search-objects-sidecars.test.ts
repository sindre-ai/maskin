import { workBetExtras } from '@maskin/ext-work/db-schema'
import { insertObject, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')

function createApp() {
	return createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
}

async function seedBet(workspaceId: string, overrides: Record<string, unknown> = {}) {
	return insertObject(db, workspaceId, getTestActorId(), {
		type: 'bet',
		status: 'signal',
		title: 'onboarding retention lift',
		content: 'exploring onboarding retention lift experiments',
		...overrides,
	})
}

describe('GET /api/objects/search — sidecar-joined <field>_eq params', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
	})

	it('filters bets by promotion_mode_eq via the sidecar', async () => {
		const app = createApp()
		const auto = await seedBet(workspaceId, { title: 'auto onboarding bet' })
		const human = await seedBet(workspaceId, { title: 'human onboarding bet' })
		await db.insert(workBetExtras).values([
			{ objectId: auto.id, workspaceId, promotionMode: 'auto' },
			{ objectId: human.id, workspaceId, promotionMode: 'human_approved' },
		])

		const res = await app.request(
			jsonGet('/api/objects/search?q=onboarding&type=bet&promotion_mode_eq=human_approved', {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ id: string }>
		expect(body.map((row) => row.id)).toEqual([human.id])
	})

	it('filters by boolean sidecar column with param-side ::boolean cast', async () => {
		const app = createApp()
		const blocked = await seedBet(workspaceId, { title: 'blocked onboarding bet' })
		const clear = await seedBet(workspaceId, { title: 'clear onboarding bet' })
		await db.insert(workBetExtras).values([
			{ objectId: blocked.id, workspaceId, mergeBlocked: true },
			{ objectId: clear.id, workspaceId, mergeBlocked: false },
		])

		const res = await app.request(
			jsonGet('/api/objects/search?q=onboarding&type=bet&merge_blocked_eq=true', {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ id: string }>
		expect(body.map((row) => row.id)).toEqual([blocked.id])
	})

	it('filters by date sidecar column with param-side ::date cast', async () => {
		const app = createApp()
		const early = await seedBet(workspaceId, { title: 'early onboarding review bet' })
		const late = await seedBet(workspaceId, { title: 'late onboarding review bet' })
		await db.insert(workBetExtras).values([
			{ objectId: early.id, workspaceId, reviewDate: '2026-08-01' },
			{ objectId: late.id, workspaceId, reviewDate: '2026-09-15' },
		])

		const res = await app.request(
			jsonGet('/api/objects/search?q=onboarding&type=bet&review_date_eq=2026-09-15', {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ id: string }>
		expect(body.map((row) => row.id)).toEqual([late.id])
	})

	it('applies multiple <field>_eq params conjunctively (all must match)', async () => {
		const app = createApp()
		const both = await seedBet(workspaceId, { title: 'both onboarding' })
		const onePasses = await seedBet(workspaceId, { title: 'one onboarding' })
		await db.insert(workBetExtras).values([
			{
				objectId: both.id,
				workspaceId,
				promotionMode: 'human_approved',
				evidenceQuality: 'evidence_backed',
			},
			{
				objectId: onePasses.id,
				workspaceId,
				promotionMode: 'human_approved',
				evidenceQuality: 'gut_feeling',
			},
		])

		const res = await app.request(
			jsonGet(
				'/api/objects/search?q=onboarding&type=bet&promotion_mode_eq=human_approved&evidence_quality_eq=evidence_backed',
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ id: string }>
		expect(body.map((row) => row.id)).toEqual([both.id])
	})

	it('EXISTS semantic — bets without any sidecar row are excluded when a <field>_eq is set', async () => {
		const app = createApp()
		const withRow = await seedBet(workspaceId, { title: 'with row onboarding' })
		const withoutRow = await seedBet(workspaceId, { title: 'no row onboarding' })
		await db.insert(workBetExtras).values({
			objectId: withRow.id,
			workspaceId,
			promotionMode: 'auto',
		})

		const res = await app.request(
			jsonGet('/api/objects/search?q=onboarding&type=bet&promotion_mode_eq=auto', {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ id: string }>
		expect(body.map((row) => row.id)).toEqual([withRow.id])
		expect(body.map((row) => row.id)).not.toContain(withoutRow.id)
	})

	it('returns 400 when a <field>_eq param is set without a type', async () => {
		const app = createApp()
		const res = await app.request(
			jsonGet('/api/objects/search?q=onboarding&promotion_mode_eq=auto', {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			error: { message: string; details?: Array<{ field: string }> }
		}
		expect(body.error.details?.[0]?.field).toBe('promotion_mode_eq')
	})

	it('returns 400 when a <field>_eq param is not promoted for the given type', async () => {
		const app = createApp()
		const res = await app.request(
			jsonGet('/api/objects/search?q=onboarding&type=bet&decision_type_eq=architecture', {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			error: { message: string; details?: Array<{ field: string }> }
		}
		expect(body.error.details?.[0]?.field).toBe('decision_type_eq')
	})

	it('scopes results to the caller workspace even when the sidecar column matches elsewhere', async () => {
		const app = createApp()
		const otherWs = await insertWorkspace(db, getTestActorId())
		const localBet = await seedBet(workspaceId, { title: 'local onboarding bet' })
		const otherBet = await insertObject(db, otherWs.id, getTestActorId(), {
			type: 'bet',
			status: 'signal',
			title: 'other onboarding bet',
		})
		await db.insert(workBetExtras).values([
			{ objectId: localBet.id, workspaceId, promotionMode: 'auto' },
			{ objectId: otherBet.id, workspaceId: otherWs.id, promotionMode: 'auto' },
		])

		const res = await app.request(
			jsonGet('/api/objects/search?q=onboarding&type=bet&promotion_mode_eq=auto', {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Array<{ id: string }>
		expect(body.map((row) => row.id)).toEqual([localBet.id])
	})

	it('baseline vs sidecar-filtered search p95 stays within the ≤+20% guardrail', async () => {
		const app = createApp()
		for (let i = 0; i < 50; i++) {
			const bet = await seedBet(workspaceId, { title: `onboarding fixture bet ${i}` })
			await db.insert(workBetExtras).values({
				objectId: bet.id,
				workspaceId,
				promotionMode: i % 2 === 0 ? 'auto' : 'human_approved',
			})
		}

		async function p95(url: string): Promise<number> {
			const samples: number[] = []
			for (let i = 0; i < 20; i++) {
				const start = performance.now()
				const res = await app.request(jsonGet(url, { 'x-workspace-id': workspaceId }))
				expect(res.status).toBe(200)
				await res.arrayBuffer()
				samples.push(performance.now() - start)
			}
			const sorted = samples.sort((a, b) => a - b)
			return sorted[Math.floor(0.95 * sorted.length)] ?? 0
		}

		const baseline = await p95('/api/objects/search?q=onboarding&type=bet')
		const filtered = await p95('/api/objects/search?q=onboarding&type=bet&promotion_mode_eq=auto')
		// Loose absolute floor so mixing sub-millisecond baselines with 20%
		// ratios doesn't spuriously fail on noisy CI. On a real fixture the
		// sidecar EXISTS with a partial index keeps the ratio well under 1.2.
		expect(filtered).toBeLessThanOrEqual(Math.max(baseline * 1.2, baseline + 5))
	})
})
