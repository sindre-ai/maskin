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
	it('returns workspace-scoped briefing markdown covering seeded bets and insights', async () => {
		const actor = await insertActor(db)
		const workspace = await insertWorkspace(db, actor.id)

		await insertObject(db, workspace.id, actor.id, {
			type: 'bet',
			status: 'active',
			title: 'Ship the onboarding rewrite',
		})
		await insertObject(db, workspace.id, actor.id, {
			type: 'insight',
			status: 'new',
			title: 'Users drop off at the workspace picker',
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
		expect(body.markdown).toContain('Ship the onboarding rewrite')
		expect(body.markdown).toContain('Users drop off at the workspace picker')
	})
})
