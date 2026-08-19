import type { StorageProvider } from '@maskin/storage'
import { describe, expect, it, vi } from 'vitest'
import briefingRoutes from '../../routes/briefing'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { createIntegrationApp, db } from './global-setup'

function createNoopStorage(): StorageProvider {
	return {
		put: vi.fn().mockResolvedValue(undefined),
		get: vi.fn().mockResolvedValue(Buffer.from('')),
		list: vi.fn().mockResolvedValue([]),
		listWithMetadata: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		ensureBucket: vi.fn().mockResolvedValue(undefined),
	} as StorageProvider
}

async function briefingApp() {
	const app = createIntegrationApp({ path: '/api/briefing', module: briefingRoutes })
	const storage = createNoopStorage()
	app.use('*', async (c, next) => {
		c.set('storageProvider', storage)
		await next()
	})
	return app
}

describe('GET /api/briefing (integration)', () => {
	it('returns markdown with the ## Loops section for seeded loops', async () => {
		const actor = await insertActor(db)
		const workspace = await insertWorkspace(db, actor.id)

		await insertObject(db, workspace.id, actor.id, {
			type: 'commitment',
			status: 'breached',
			title: 'Onboarding NPS floor',
			metadata: { floor: '≥40 NPS', cadence: 'monthly' },
		})
		await insertObject(db, workspace.id, actor.id, {
			type: 'commitment',
			status: 'at-risk',
			title: 'Customer bugs fixed <1 day',
			metadata: { floor: '<1 day median TTR', cadence: 'weekly' },
		})
		await insertObject(db, workspace.id, actor.id, {
			type: 'commitment',
			status: 'holding',
			title: 'Weekly release cadence',
			metadata: { floor: 'ship at least 1/week', cadence: 'weekly' },
		})

		const app = await briefingApp()
		const res = await app.request(
			new Request('http://localhost/api/briefing', {
				headers: { 'x-workspace-id': workspace.id },
			}),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { workspace_id: string; markdown: string }
		expect(body.workspace_id).toBe(workspace.id)

		const md = body.markdown
		expect(md).toContain('## Commitments')

		// Breached must sort ahead of at-risk, at-risk ahead of holding.
		const loopSection = md.slice(md.indexOf('## Commitments'))
		const breachedIdx = loopSection.indexOf('Onboarding NPS floor')
		const atRiskIdx = loopSection.indexOf('Customer bugs fixed <1 day')
		const holdingIdx = loopSection.indexOf('Weekly release cadence')
		expect(breachedIdx).toBeGreaterThanOrEqual(0)
		expect(atRiskIdx).toBeGreaterThan(breachedIdx)
		expect(holdingIdx).toBeGreaterThan(atRiskIdx)

		// Floor + cadence render next to the status chip.
		expect(md).toContain('floor: ≥40 NPS')
		expect(md).toContain('cadence: weekly')
	})

	it('stays silent (no ## Loops section) when no loops exist', async () => {
		const actor = await insertActor(db)
		const workspace = await insertWorkspace(db, actor.id)

		const app = await briefingApp()
		const res = await app.request(
			new Request('http://localhost/api/briefing', {
				headers: { 'x-workspace-id': workspace.id },
			}),
		)

		expect(res.status).toBe(200)
		const { markdown } = (await res.json()) as { markdown: string }
		expect(markdown).not.toContain('## Commitments')
	})
})
