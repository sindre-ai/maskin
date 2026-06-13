import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildWorkspaceMember } from '../factories'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: installedPackagesRoutes } = await import('../../routes/installed-packages')

const ACTOR_ID = 'test-actor-id'

function setup() {
	return createTestApp(installedPackagesRoutes, '/api/installed-packages', ACTOR_ID)
}

function pkg(overrides?: Record<string, unknown>) {
	return {
		id: randomUUID(),
		name: 'Customer Continuous Discovery',
		slug: 'customer-continuous-discovery',
		description: 'A loop',
		version: '1.0.0',
		useCase: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

function installRow(overrides?: Record<string, unknown>) {
	return {
		id: randomUUID(),
		workspaceId: randomUUID(),
		sourcePackageId: randomUUID(),
		installedVersion: '1.0.0',
		isLocked: true,
		forkedAt: null,
		installedAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

describe('POST /api/installed-packages', () => {
	it('installs a package with no items and returns 201', async () => {
		const { app, mockResults, calls } = setup()
		const workspaceId = randomUUID()
		const packageId = randomUUID()
		const install = installRow({ workspaceId, sourcePackageId: packageId })

		mockResults.selectQueue = [
			// isWorkspaceMember
			[buildWorkspaceMember({ workspaceId, actorId: ACTOR_ID })],
			// catalogPackages lookup
			[pkg({ id: packageId })],
			// catalogPackageItems — empty
			[],
			// existing installed_packages check — none
			[],
		]
		mockResults.insert = [install]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-packages', { packageId, workspaceId }),
		)

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.id).toBe(install.id)
		expect(body.workspaceId).toBe(workspaceId)
		expect(body.sourcePackageId).toBe(packageId)
		expect(body.installedVersion).toBe('1.0.0')
		expect(body.isLocked).toBe(true)
		expect(body.provisioned).toEqual({
			actors: 0,
			triggers: 0,
			skills: 0,
			integrations: 0,
		})
		// One insert for installed_packages + one for the event row.
		expect(calls.inserts.length).toBeGreaterThanOrEqual(2)
	})

	it('provisions actor + trigger and rewrites target_actor_id to the local id', async () => {
		const { app, mockResults, calls } = setup()
		const workspaceId = randomUUID()
		const packageId = randomUUID()
		const install = installRow({ workspaceId, sourcePackageId: packageId })

		const sourceActorId = '11111111-1111-1111-1111-111111111111'
		const newActorId = '22222222-2222-2222-2222-222222222222'
		const newTriggerId = '33333333-3333-3333-3333-333333333333'

		const items = [
			{
				id: randomUUID(),
				packageId,
				itemType: 'actor',
				sourceItemId: sourceActorId,
				itemSnapshot: { name: 'Researcher', type: 'agent', systemPrompt: 'Listen.' },
				createdAt: new Date(),
			},
			{
				id: randomUUID(),
				packageId,
				itemType: 'trigger',
				sourceItemId: '44444444-4444-4444-4444-444444444444',
				itemSnapshot: {
					name: 'Daily',
					type: 'cron',
					config: { expression: '0 9 * * *' },
					actionPrompt: 'Run.',
					target_actor_id: sourceActorId,
				},
				createdAt: new Date(),
			},
		]

		mockResults.selectQueue = [
			[buildWorkspaceMember({ workspaceId, actorId: ACTOR_ID })],
			[pkg({ id: packageId })],
			items,
			[],
		]
		// Inserts fire in this order: installed_packages, actor, trigger, event.
		mockResults.insertQueue = [[install], [{ id: newActorId }], [{ id: newTriggerId }], []]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-packages', { packageId, workspaceId }),
		)

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.provisioned).toEqual({ actors: 1, triggers: 1, skills: 0, integrations: 0 })

		// 4th insert is the trigger: its targetActorId should have been rewritten to
		// the freshly-minted local actor id, not the publisher's source actor id.
		const triggerInsert = calls.inserts[2] as Record<string, unknown>
		expect(triggerInsert.targetActorId).toBe(newActorId)
		// Metadata snapshot also carries the rewritten id, not the source id.
		const triggerMeta = triggerInsert.metadata as Record<string, unknown>
		const triggerSnapshot = triggerMeta.snapshot as Record<string, unknown>
		expect(triggerSnapshot.target_actor_id).toBe(newActorId)
		expect(triggerMeta.installed_package_id).toBe(install.id)
	})

	it('returns 403 when the caller is not a member of the workspace', async () => {
		const { app, mockResults } = setup()
		const workspaceId = randomUUID()
		const packageId = randomUUID()
		// Empty member lookup → not a member.
		mockResults.selectQueue = [[]]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-packages', { packageId, workspaceId }),
		)

		expect(res.status).toBe(403)
		const body = await res.json()
		expect(body.error.code).toBe('FORBIDDEN')
	})

	it('returns 404 when the catalog package is missing', async () => {
		const { app, mockResults } = setup()
		const workspaceId = randomUUID()
		const packageId = randomUUID()
		mockResults.selectQueue = [
			[buildWorkspaceMember({ workspaceId, actorId: ACTOR_ID })],
			// Package lookup — empty
			[],
		]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-packages', { packageId, workspaceId }),
		)

		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body.error.code).toBe('NOT_FOUND')
	})

	it('returns 409 when the package is already installed in the workspace', async () => {
		const { app, mockResults } = setup()
		const workspaceId = randomUUID()
		const packageId = randomUUID()
		mockResults.selectQueue = [
			[buildWorkspaceMember({ workspaceId, actorId: ACTOR_ID })],
			[pkg({ id: packageId })],
			[],
			// Existing installed_packages row → conflict.
			[{ id: randomUUID() }],
		]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-packages', { packageId, workspaceId }),
		)

		expect(res.status).toBe(409)
		const body = await res.json()
		expect(body.error.code).toBe('CONFLICT')
	})

	it('returns 400 for an invalid body', async () => {
		const { app } = setup()
		const res = await app.request(
			jsonRequest('POST', '/api/installed-packages', { packageId: 'not-a-uuid' }),
		)
		expect(res.status).toBe(400)
	})
})

describe('POST /api/installed-packages/:id/fork', () => {
	it('flips the install row and detaches every matching element row', async () => {
		const { app, mockResults, calls } = setup()
		const install = installRow({ isLocked: true, forkedAt: null })
		const forked = { ...install, isLocked: false, forkedAt: new Date() }

		mockResults.selectQueue = [
			// installedPackages lookup
			[install],
			// isWorkspaceMember
			[buildWorkspaceMember({ workspaceId: install.workspaceId, actorId: ACTOR_ID })],
		]
		mockResults.updateQueue = [
			// installedPackages flip
			[forked],
			// actors detach
			[{ id: 'a1' }, { id: 'a2' }],
			// triggers detach
			[{ id: 't1' }],
			// workspace_skills detach
			[],
			// integrations detach
			[{ id: 'i1' }],
		]

		const res = await app.request(jsonRequest('POST', `/api/installed-packages/${install.id}/fork`))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.id).toBe(install.id)
		expect(body.isLocked).toBe(false)
		expect(body.forkedAt).not.toBeNull()
		expect(body.detached).toEqual({ actors: 2, triggers: 1, skills: 0, integrations: 1 })

		// 5 updates land: install row + four element tables.
		expect(calls.updates).toHaveLength(5)
		const installUpdate = calls.updates[0] as Record<string, unknown>
		expect(installUpdate.isLocked).toBe(false)
		expect(installUpdate.forkedAt).toBeInstanceOf(Date)
		expect(installUpdate.updatedAt).toBeInstanceOf(Date)
	})

	it('returns 404 when the install row is missing', async () => {
		const { app, mockResults } = setup()
		mockResults.selectQueue = [[]]
		const res = await app.request(
			jsonRequest('POST', `/api/installed-packages/${randomUUID()}/fork`),
		)
		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body.error.code).toBe('NOT_FOUND')
	})

	it('returns 403 when the caller is not a member of the install workspace', async () => {
		const { app, mockResults } = setup()
		const install = installRow({ isLocked: true })
		mockResults.selectQueue = [
			[install],
			// isWorkspaceMember — empty
			[],
		]
		const res = await app.request(jsonRequest('POST', `/api/installed-packages/${install.id}/fork`))
		expect(res.status).toBe(403)
		const body = await res.json()
		expect(body.error.code).toBe('FORBIDDEN')
	})

	it('returns 409 when the install is already forked', async () => {
		const { app, mockResults } = setup()
		const install = installRow({ isLocked: false, forkedAt: new Date() })
		mockResults.selectQueue = [
			[install],
			[buildWorkspaceMember({ workspaceId: install.workspaceId, actorId: ACTOR_ID })],
		]
		const res = await app.request(jsonRequest('POST', `/api/installed-packages/${install.id}/fork`))
		expect(res.status).toBe(409)
		const body = await res.json()
		expect(body.error.code).toBe('CONFLICT')
	})

	it('returns 400 for a non-UUID id', async () => {
		const { app } = setup()
		const res = await app.request(jsonRequest('POST', '/api/installed-packages/not-a-uuid/fork'))
		expect(res.status).toBe(400)
	})

	// Two concurrent forks both pass the pre-tx `if (!install.isLocked)` check
	// because they read the row before either UPDATE has committed. The UPDATE
	// inside the tx has an `is_locked = true` guard, so the loser's UPDATE
	// matches zero rows. Simulated here by an empty `.returning()` on the install
	// flip: handler must bail out of the tx (no element detaches, no audit event)
	// and return 409.
	it('returns 409 and writes no audit event when a concurrent fork won the install UPDATE race', async () => {
		const { app, mockResults, calls } = setup()
		const install = installRow({ isLocked: true, forkedAt: null })

		mockResults.selectQueue = [
			[install],
			[buildWorkspaceMember({ workspaceId: install.workspaceId, actorId: ACTOR_ID })],
		]
		// Install UPDATE matches zero rows — the row's already been flipped by the
		// winning concurrent tx. Element-row UPDATEs should never run, so no
		// further queue entries are needed.
		mockResults.updateQueue = [[]]

		const res = await app.request(jsonRequest('POST', `/api/installed-packages/${install.id}/fork`))

		expect(res.status).toBe(409)
		const body = await res.json()
		expect(body.error.code).toBe('CONFLICT')
		// Only the install UPDATE was attempted; the four element-table UPDATEs
		// (actors/triggers/workspace_skills/integrations) were correctly skipped.
		expect(calls.updates).toHaveLength(1)
		// And critically: no `installed_package.forked` event row was inserted —
		// that's the duplicate-audit failure mode the guard exists to prevent.
		expect(calls.inserts).toHaveLength(0)
	})
})
