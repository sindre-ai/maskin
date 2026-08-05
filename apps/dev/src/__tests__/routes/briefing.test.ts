import { describe, expect, it, vi } from 'vitest'
import briefingRoutes from '../../routes/briefing'
import { buildObject, buildWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createImportTestApp } from '../setup'

const wsId = '00000000-0000-0000-0000-000000000001'

// Order of queries inside renderWorkspaceBriefing (auth middleware is bypassed
// in tests, so no membership select is prepended):
//   1. workspace lookup
//   2-6. Promise.all: activeBets, pausedBets, closedBets, openInsights, commitments

describe('GET /api/briefing', () => {
	it('returns the composed briefing markdown for the workspace', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(
			briefingRoutes,
			'/api/briefing',
		)
		const ws = buildWorkspace({ id: wsId, name: 'Acme' })
		mockResults.selectQueue = [[ws], [], [], [], [], []]
		vi.mocked(storageProvider.exists).mockResolvedValue(false)

		const res = await app.request(jsonGet('/api/briefing', { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { workspace_id: string; markdown: string }
		expect(body.workspace_id).toBe(wsId)
		expect(body.markdown).toContain('Acme — workspace briefing')
	})

	it('includes the ## Commitments section when commitments are seeded', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(
			briefingRoutes,
			'/api/briefing',
		)
		const ws = buildWorkspace({ id: wsId })
		const atRisk = buildObject({
			workspaceId: wsId,
			type: 'commitment',
			status: 'at-risk',
			title: 'Customer bugs fixed <1 day',
			metadata: { floor: '≤1 day median TTR', cadence: 'weekly' },
		})
		const breached = buildObject({
			workspaceId: wsId,
			type: 'commitment',
			status: 'breached',
			title: 'Onboarding NPS ≥ 40',
			metadata: { floor: '≥40 NPS', cadence: 'monthly' },
		})
		const holding = buildObject({
			workspaceId: wsId,
			type: 'commitment',
			status: 'holding',
			title: 'Weekly deploy Fridays',
			metadata: { floor: 'ship at least 1/week', cadence: 'weekly' },
		})
		mockResults.selectQueue = [[ws], [], [], [], [], [breached, atRisk, holding]]
		vi.mocked(storageProvider.exists).mockResolvedValue(false)

		const res = await app.request(jsonGet('/api/briefing', { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		const { markdown } = (await res.json()) as { markdown: string }

		expect(markdown).toContain('## Commitments')

		// Priority ordering: breached appears before at-risk, at-risk before holding.
		const breachedIdx = markdown.indexOf('Onboarding NPS ≥ 40')
		const atRiskIdx = markdown.indexOf('Customer bugs fixed <1 day')
		const holdingIdx = markdown.indexOf('Weekly deploy Fridays')
		expect(breachedIdx).toBeGreaterThan(-1)
		expect(atRiskIdx).toBeGreaterThan(breachedIdx)
		expect(holdingIdx).toBeGreaterThan(atRiskIdx)

		// Floor + cadence render inline next to the status chip.
		expect(markdown).toContain('floor: ≥40 NPS')
		expect(markdown).toContain('cadence: weekly')
	})

	it('omits the ## Commitments section when no commitments exist', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(
			briefingRoutes,
			'/api/briefing',
		)
		const ws = buildWorkspace({ id: wsId })
		mockResults.selectQueue = [[ws], [], [], [], [], []]
		vi.mocked(storageProvider.exists).mockResolvedValue(false)

		const res = await app.request(jsonGet('/api/briefing', { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		const { markdown } = (await res.json()) as { markdown: string }
		expect(markdown).not.toContain('## Commitments')
	})

	it('returns 400 when x-workspace-id header is missing', async () => {
		const { app } = createImportTestApp(briefingRoutes, '/api/briefing')
		const res = await app.request(jsonGet('/api/briefing'))
		expect(res.status).toBe(400)
	})
})
