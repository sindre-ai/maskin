import { describe, expect, it, vi } from 'vitest'
import briefingRoutes from '../../routes/briefing'
import { buildObject, buildWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createImportTestApp } from '../setup'

const wsId = '00000000-0000-0000-0000-000000000001'

// Order of queries inside renderWorkspaceBriefing (auth middleware is bypassed
// in tests, so no membership select is prepended):
//   1. workspace lookup
//   2-6. Promise.all: activeBets, pausedBets, closedBets, openInsights, loops

describe('GET /api/briefing', () => {
	it('returns the composed briefing markdown for the workspace', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(
			briefingRoutes,
			'/api/briefing',
		)
		const ws = buildWorkspace({ id: wsId, name: 'Acme' })
		mockResults.selectQueue = [[ws], [], [], [], []]
		vi.mocked(storageProvider.exists).mockResolvedValue(false)

		const res = await app.request(jsonGet('/api/briefing', { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { workspace_id: string; markdown: string }
		expect(body.workspace_id).toBe(wsId)
		expect(body.markdown).toContain('Acme — workspace briefing')
	})

	it('returns 400 when x-workspace-id header is missing', async () => {
		const { app } = createImportTestApp(briefingRoutes, '/api/briefing')
		const res = await app.request(jsonGet('/api/briefing'))
		expect(res.status).toBe(400)
	})
})
