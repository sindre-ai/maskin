import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceMember } from '../factories'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { trackLoopInstalledMock, trackLoopForkedMock, trackLoopUninstalledMock } = vi.hoisted(
	() => ({
		trackLoopInstalledMock: vi.fn().mockResolvedValue(undefined),
		trackLoopForkedMock: vi.fn().mockResolvedValue(undefined),
		trackLoopUninstalledMock: vi.fn().mockResolvedValue(undefined),
	}),
)
vi.mock('../../lib/analytics/loop-events', () => ({
	trackLoopInstalled: trackLoopInstalledMock,
	trackLoopForked: trackLoopForkedMock,
	trackLoopUninstalled: trackLoopUninstalledMock,
}))

const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')

const ACTOR_ID = 'test-actor-id'

function setup() {
	return createTestApp(installedLoopsRoutes, '/api/installed-loops', ACTOR_ID)
}

function loop(overrides?: Record<string, unknown>) {
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
		sourceLoopId: randomUUID(),
		objectId: null,
		installedVersion: '1.0.0',
		isLocked: true,
		forkedAt: null,
		installedAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

function loopObjectRow(overrides?: Record<string, unknown>) {
	return {
		id: randomUUID(),
		type: 'loop',
		title: 'Customer Continuous Discovery',
		status: 'running',
		...overrides,
	}
}

describe('POST /api/installed-loops', () => {
	beforeEach(() => {
		trackLoopInstalledMock.mockClear()
	})

	it('installs a loop with no items and returns 201 with the linked Loop object id', async () => {
		const { app, mockResults, calls } = setup()
		const workspaceId = randomUUID()
		const loopId = randomUUID()
		const install = installRow({ workspaceId, sourceLoopId: loopId })
		const loopObject = loopObjectRow()

		mockResults.selectQueue = [
			// isWorkspaceMember
			[buildWorkspaceMember({ workspaceId, actorId: ACTOR_ID })],
			// marketplaceLoops lookup
			[loop({ id: loopId })],
			// marketplaceLoopItems — empty
			[],
			// existing installed_loops check — none
			[],
		]
		// installed_loops, loop object, loop event, installed_loop event, auto-subscribe.
		mockResults.insertQueue = [[install], [loopObject], [], [], []]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
		)

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.id).toBe(install.id)
		expect(body.workspaceId).toBe(workspaceId)
		expect(body.sourceLoopId).toBe(loopId)
		expect(body.objectId).toBe(loopObject.id)
		expect(body.installedVersion).toBe('1.0.0')
		expect(body.isLocked).toBe(true)
		expect(body.provisioned).toEqual({
			actors: 0,
			triggers: 0,
			skills: 0,
			integrations: 0,
		})

		// The install creates an `objects` row of type 'loop' pointing back at the
		// marketplace loop it came from, and links it on the install row.
		const objectInsert = calls.inserts[1] as Record<string, unknown>
		expect(objectInsert).toMatchObject({ workspaceId, type: 'loop', status: 'running' })
		expect(objectInsert.metadata).toEqual({
			installed_from_marketplace_loop_id: loopId,
			trigger_ids: [],
		})
		const linkUpdate = calls.updates[0] as Record<string, unknown>
		expect(linkUpdate.objectId).toBe(loopObject.id)
	})

	it('provisions actor + trigger, rewrites target_actor_id, and seeds the Loop object trigger_ids', async () => {
		const { app, mockResults, calls } = setup()
		const workspaceId = randomUUID()
		const loopId = randomUUID()
		const install = installRow({ workspaceId, sourceLoopId: loopId })
		const loopObject = loopObjectRow()

		const sourceActorId = '11111111-1111-1111-1111-111111111111'
		const newActorId = '22222222-2222-2222-2222-222222222222'
		const newTriggerId = '33333333-3333-3333-3333-333333333333'

		const items = [
			{
				id: randomUUID(),
				loopId,
				itemType: 'actor',
				sourceItemId: sourceActorId,
				itemSnapshot: { name: 'Researcher', type: 'agent', systemPrompt: 'Listen.' },
				createdAt: new Date(),
			},
			{
				id: randomUUID(),
				loopId,
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
			[loop({ id: loopId })],
			items,
			[],
			// Claim pre-check: nothing installed yet — miss, the INSERT claims.
			[],
		]
		// Inserts fire in this order: installed_loops, actor, workspace_members
		// (binds the provisioned agent to the workspace), trigger, loop object,
		// loop event, installed_loop event, auto-subscribe.
		mockResults.insertQueue = [
			[install],
			[{ id: newActorId }],
			[],
			[{ id: newTriggerId }],
			[loopObject],
			[],
			[],
			[],
		]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
		)

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.provisioned).toEqual({ actors: 1, triggers: 1, skills: 0, integrations: 0 })

		// 3rd insert binds the freshly-minted actor to the target workspace as a
		// member — without it the agent is orphaned and its trigger can't run.
		const memberInsert = calls.inserts[2] as Record<string, unknown>
		expect(memberInsert.workspaceId).toBe(workspaceId)
		expect(memberInsert.actorId).toBe(newActorId)
		expect(memberInsert.role).toBe('member')

		// 4th insert is the trigger: its targetActorId should have been rewritten to
		// the freshly-minted local actor id, not the publisher's source actor id.
		const triggerInsert = calls.inserts[3] as Record<string, unknown>
		expect(triggerInsert.targetActorId).toBe(newActorId)
		// Metadata snapshot also carries the rewritten id, not the source id.
		const triggerMeta = triggerInsert.metadata as Record<string, unknown>
		const triggerSnapshot = triggerMeta.snapshot as Record<string, unknown>
		expect(triggerSnapshot.target_actor_id).toBe(newActorId)
		expect(triggerMeta.installed_loop_id).toBe(install.id)

		// 5th insert is the Loop object: its trigger_ids carry every trigger this
		// install provisioned, which is what GET /api/loops reads agents from.
		const objectInsert = calls.inserts[4] as Record<string, unknown>
		expect(objectInsert.type).toBe('loop')
		expect(objectInsert.metadata).toEqual({
			installed_from_marketplace_loop_id: loopId,
			trigger_ids: [newTriggerId],
		})
	})

	it('reuses a pre-existing provisioned actor found by the pre-check — no actor insert at all, trigger wired to the existing agent', async () => {
		// The workspace already holds an actor provisioned from this exact source
		// item — a row created BEFORE the unique index shipped (workspace_id NULL,
		// so the index never covers it and a claim INSERT would "succeed" against
		// it, cloning the agent). The manifest for this test is that the claim
		// insert is never even attempted: the pre-check (scoped through
		// workspace_members) short-circuits straight to reuse.
		const { app, mockResults, calls } = setup()
		const workspaceId = randomUUID()
		const loopId = randomUUID()
		const install = installRow({ workspaceId, sourceLoopId: loopId })
		const loopObject = loopObjectRow()
		const sourceActorId = '11111111-1111-1111-1111-111111111111'
		const existingActorId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
		const newTriggerId = '33333333-3333-3333-3333-333333333333'
		const items = [
			{
				id: randomUUID(),
				loopId,
				itemType: 'actor',
				sourceItemId: sourceActorId,
				itemSnapshot: { name: 'Researcher', type: 'agent', systemPrompt: 'Listen.' },
				createdAt: new Date(),
			},
			{
				id: randomUUID(),
				loopId,
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
			[loop({ id: loopId })],
			items,
			[],
			// Claim pre-check HITS: the workspace already holds the agent from a
			// prior install (another loop, or a kept-as-items uninstall).
			[{ id: existingActorId }],
		]
		// 6 inserts: install, trigger, loop object, loop event, installed_loop
		// event, auto-subscribe. NO actor claim, NO workspace_members row — a
		// reused agent is already bound to the workspace.
		mockResults.insertQueue = [[install], [{ id: newTriggerId }], [loopObject], [], [], []]
		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
		)
		expect(res.status).toBe(201)
		const body = await res.json()
		// Reuse means the install created zero actors of its own.
		expect(body.provisioned).toEqual({ actors: 0, triggers: 1, skills: 0, integrations: 0 })
		expect(calls.inserts).toHaveLength(6)
		// The no-clone proof: the actor claim INSERT was never attempted — cloning
		// a legacy row is impossible because there is no insert to clone with.
		expect(calls.inserts).not.toContainEqual(expect.objectContaining({ type: 'agent' }))
		// A cloned agent would have shipped with a membership insert; none did.
		expect(calls.inserts).not.toContainEqual(expect.objectContaining({ role: 'member' }))
		// The trigger wires to the EXISTING actor, not a fresh clone.
		const triggerInsert = calls.inserts[1] as Record<string, unknown>
		expect(triggerInsert.targetActorId).toBe(existingActorId)
		const triggerSnapshot = (triggerInsert.metadata as Record<string, unknown>).snapshot as Record<
			string,
			unknown
		>
		expect(triggerSnapshot.target_actor_id).toBe(existingActorId)
	})
	it('races a concurrent install and reuses the winner after losing the claim — no clone, no member insert', async () => {
		// Both racing installs probed an empty workspace (pre-check miss); the
		// claim INSERT loses to the concurrent winner via the unique index, and
		// the follow-up read (fresh READ COMMITTED snapshot) returns the winner's
		// row. This is the TOCTOU closure: exactly one caller wins the claim; the
		// loser reuses instead of cloning.
		const { app, mockResults, calls } = setup()
		const workspaceId = randomUUID()
		const loopId = randomUUID()
		const install = installRow({ workspaceId, sourceLoopId: loopId })
		const loopObject = loopObjectRow()
		const sourceActorId = '11111111-1111-1111-1111-111111111111'
		const existingActorId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
		const newTriggerId = '33333333-3333-3333-3333-333333333333'
		const items = [
			{
				id: randomUUID(),
				loopId,
				itemType: 'actor',
				sourceItemId: sourceActorId,
				itemSnapshot: { name: 'Researcher', type: 'agent', systemPrompt: 'Listen.' },
				createdAt: new Date(),
			},
			{
				id: randomUUID(),
				loopId,
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
			[loop({ id: loopId })],
			items,
			[],
			// Claim pre-check: nothing committed yet — miss.
			[],
			// Re-read after the lost claim: the winner's committed row.
			[{ id: existingActorId }],
		]
		// 7 inserts: install, actor claim (lost), trigger, loop object, loop event,
		// installed_loop event, auto-subscribe.
		mockResults.insertQueue = [[install], [], [{ id: newTriggerId }], [loopObject], [], [], []]
		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
		)
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.provisioned).toEqual({ actors: 0, triggers: 1, skills: 0, integrations: 0 })
		expect(calls.inserts).toHaveLength(7)
		// The claim insert WAS attempted (that's the arbiter) and stamped the
		// dedup anchor
		const claimInsert = calls.inserts[1] as Record<string, unknown>
		expect(claimInsert.type).toBe('agent')
		expect(claimInsert.metadata).toMatchObject({ source_item_id: sourceActorId })
		// — but losing it means no workspace_members row — a cloned agent would
		// have shipped with a membership insert.
		expect(calls.inserts).not.toContainEqual(expect.objectContaining({ role: 'member' }))
		// The trigger wires to the winner, not a clone.
		const triggerInsert = calls.inserts[2] as Record<string, unknown>
		expect(triggerInsert.targetActorId).toBe(existingActorId)
	})

	it('returns 403 when the caller is not a member of the workspace', async () => {
		const { app, mockResults } = setup()
		const workspaceId = randomUUID()
		const loopId = randomUUID()
		// Empty member lookup → not a member.
		mockResults.selectQueue = [[]]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
		)

		expect(res.status).toBe(403)
		const body = await res.json()
		expect(body.error.code).toBe('FORBIDDEN')
	})

	it('returns 404 when the marketplace loop is missing', async () => {
		const { app, mockResults } = setup()
		const workspaceId = randomUUID()
		const loopId = randomUUID()
		mockResults.selectQueue = [
			[buildWorkspaceMember({ workspaceId, actorId: ACTOR_ID })],
			// Loop lookup — empty
			[],
		]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
		)

		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body.error.code).toBe('NOT_FOUND')
	})

	it('returns 409 when the loop is already installed in the workspace', async () => {
		const { app, mockResults } = setup()
		const workspaceId = randomUUID()
		const loopId = randomUUID()
		mockResults.selectQueue = [
			[buildWorkspaceMember({ workspaceId, actorId: ACTOR_ID })],
			[loop({ id: loopId })],
			[],
			// Existing installed_loops row → conflict.
			[{ id: randomUUID() }],
		]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
		)

		expect(res.status).toBe(409)
		const body = await res.json()
		expect(body.error.code).toBe('CONFLICT')
	})

	it('emits loop_installed to PostHog after a successful install', async () => {
		const { app, mockResults } = setup()
		const workspaceId = randomUUID()
		const loopId = randomUUID()
		const install = installRow({ workspaceId, sourceLoopId: loopId })

		mockResults.selectQueue = [
			[buildWorkspaceMember({ workspaceId, actorId: ACTOR_ID })],
			[loop({ id: loopId, slug: 'customer-continuous-discovery', version: '1.4.2' })],
			[],
			[],
		]
		mockResults.insertQueue = [[install], [loopObjectRow()], [], [], []]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
		)

		expect(res.status).toBe(201)
		// Fire-and-forget — give the microtask queue a tick to drain.
		await Promise.resolve()
		expect(trackLoopInstalledMock).toHaveBeenCalledOnce()
		expect(trackLoopInstalledMock).toHaveBeenCalledWith({
			loopId,
			loopSlug: 'customer-continuous-discovery',
			loopVersion: '1.4.2',
			workspaceId,
			actorId: ACTOR_ID,
			provisioned: { actors: 0, triggers: 0, skills: 0, integrations: 0 },
		})
	})

	it('passes the provisioned counter through to the emit so the bundle-card discriminator can be derived', async () => {
		const { app, mockResults } = setup()
		const workspaceId = randomUUID()
		const loopId = randomUUID()
		const install = installRow({ workspaceId, sourceLoopId: loopId })

		const sourceActorId = '11111111-1111-1111-1111-111111111111'
		const newActorId = '22222222-2222-2222-2222-222222222222'
		const newTriggerId = '33333333-3333-3333-3333-333333333333'
		const items = [
			{
				id: randomUUID(),
				loopId,
				itemType: 'actor',
				sourceItemId: sourceActorId,
				itemSnapshot: { name: 'Researcher', type: 'agent', systemPrompt: 'Listen.' },
				createdAt: new Date(),
			},
			{
				id: randomUUID(),
				loopId,
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
			[loop({ id: loopId })],
			items,
			[],
		]
		mockResults.insertQueue = [
			[install],
			[{ id: newActorId }],
			[],
			[{ id: newTriggerId }],
			[loopObjectRow()],
			[],
			[],
			[],
		]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
		)

		expect(res.status).toBe(201)
		await Promise.resolve()
		expect(trackLoopInstalledMock).toHaveBeenCalledOnce()
		const call = trackLoopInstalledMock.mock.calls[0]?.[0] as { provisioned: unknown }
		expect(call.provisioned).toEqual({ actors: 1, triggers: 1, skills: 0, integrations: 0 })
	})

	it('does not emit loop_installed when the install fails', async () => {
		const { app, mockResults } = setup()
		const workspaceId = randomUUID()
		const loopId = randomUUID()
		// Missing loop → 404 path, no emit.
		mockResults.selectQueue = [[buildWorkspaceMember({ workspaceId, actorId: ACTOR_ID })], []]

		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }),
		)

		expect(res.status).toBe(404)
		await Promise.resolve()
		expect(trackLoopInstalledMock).not.toHaveBeenCalled()
	})

	it('returns 400 for an invalid body', async () => {
		const { app } = setup()
		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId: 'not-a-uuid' }),
		)
		expect(res.status).toBe(400)
	})
})

describe('POST /api/installed-loops/:id/fork', () => {
	beforeEach(() => {
		trackLoopForkedMock.mockClear()
	})

	it('flips the install row and detaches every matching element row', async () => {
		const { app, mockResults, calls } = setup()
		const install = installRow({ isLocked: true, forkedAt: null })
		const forked = { ...install, isLocked: false, forkedAt: new Date() }

		mockResults.selectQueue = [
			// installedLoops lookup
			[install],
			// isWorkspaceMember
			[buildWorkspaceMember({ workspaceId: install.workspaceId, actorId: ACTOR_ID })],
		]
		mockResults.updateQueue = [
			// installedLoops flip
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

		const res = await app.request(jsonRequest('POST', `/api/installed-loops/${install.id}/fork`))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.id).toBe(install.id)
		expect(body.isLocked).toBe(false)
		expect(body.forkedAt).not.toBeNull()
		expect(body.detached).toEqual({ actors: 2, triggers: 1, skills: 0, integrations: 1 })

		// 5 updates land: install row + four element tables. The linked Loop object
		// is deliberately untouched — forking changes element ownership, not the
		// running loop.
		expect(calls.updates).toHaveLength(5)
		const installUpdate = calls.updates[0] as Record<string, unknown>
		expect(installUpdate.isLocked).toBe(false)
		expect(installUpdate.forkedAt).toBeInstanceOf(Date)
		expect(installUpdate.updatedAt).toBeInstanceOf(Date)

		expect(trackLoopForkedMock).toHaveBeenCalledOnce()
		expect(trackLoopForkedMock).toHaveBeenCalledWith({
			loopId: forked.sourceLoopId,
			installedLoopId: forked.id,
			versionAtFork: forked.installedVersion,
			workspaceId: forked.workspaceId,
			actorId: ACTOR_ID,
		})
	})

	it('returns 404 when the install row is missing', async () => {
		const { app, mockResults } = setup()
		mockResults.selectQueue = [[]]
		const res = await app.request(jsonRequest('POST', `/api/installed-loops/${randomUUID()}/fork`))
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
		const res = await app.request(jsonRequest('POST', `/api/installed-loops/${install.id}/fork`))
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
		const res = await app.request(jsonRequest('POST', `/api/installed-loops/${install.id}/fork`))
		expect(res.status).toBe(409)
		const body = await res.json()
		expect(body.error.code).toBe('CONFLICT')
	})

	it('returns 400 for a non-UUID id', async () => {
		const { app } = setup()
		const res = await app.request(jsonRequest('POST', '/api/installed-loops/not-a-uuid/fork'))
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

		const res = await app.request(jsonRequest('POST', `/api/installed-loops/${install.id}/fork`))

		expect(res.status).toBe(409)
		const body = await res.json()
		expect(body.error.code).toBe('CONFLICT')
		// Only the install UPDATE was attempted; the four element-table UPDATEs
		// (actors/triggers/workspace_skills/integrations) were correctly skipped.
		expect(calls.updates).toHaveLength(1)
		// And critically: no `installed_loop.forked` event row was inserted —
		// that's the duplicate-audit failure mode the guard exists to prevent.
		expect(calls.inserts).toHaveLength(0)
	})
})

describe('DELETE /api/installed-loops/:id', () => {
	beforeEach(() => {
		trackLoopUninstalledMock.mockClear()
	})

	it('reports removedLoopObject false when the elements are kept', async () => {
		const { app, mockResults } = setup()
		const install = installRow({ objectId: randomUUID() })

		mockResults.selectQueue = [
			[install],
			[buildWorkspaceMember({ workspaceId: install.workspaceId, actorId: ACTOR_ID })],
		]

		const res = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${install.id}`, {
				keepProvisionedItems: true,
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.deleted).toBe(true)
		// Keeping the elements keeps the linked Loop object — it becomes a plain,
		// user-owned Loop rather than being deleted along with the install row.
		expect(body.removedLoopObject).toBe(false)
	})

	it('returns 404 when the install row is missing', async () => {
		const { app, mockResults } = setup()
		mockResults.selectQueue = [[]]
		const res = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${randomUUID()}`, {
				keepProvisionedItems: false,
			}),
		)
		expect(res.status).toBe(404)
	})

	it('returns 403 when the caller is not a member of the install workspace', async () => {
		const { app, mockResults } = setup()
		const install = installRow()
		mockResults.selectQueue = [[install], []]
		const res = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${install.id}`, {
				keepProvisionedItems: false,
			}),
		)
		expect(res.status).toBe(403)
	})

	it('returns 400 when keepProvisionedItems is missing', async () => {
		const { app } = setup()
		const res = await app.request(jsonRequest('DELETE', `/api/installed-loops/${randomUUID()}`, {}))
		expect(res.status).toBe(400)
	})
})

describe('GET /api/installed-loops', () => {
	it('returns installs joined with the current marketplace version and a hasUpdate flag', async () => {
		const { app, mockResults } = setup()
		const workspaceId = randomUUID()
		const loopIdA = randomUUID()
		const loopIdB = randomUUID()
		const installA = installRow({
			workspaceId,
			sourceLoopId: loopIdA,
			installedVersion: '1.0.0',
		})
		const installB = installRow({
			workspaceId,
			sourceLoopId: loopIdB,
			installedVersion: '1.0.0',
			isLocked: false,
			forkedAt: new Date(),
		})

		mockResults.selectQueue = [
			[buildWorkspaceMember({ workspaceId, actorId: ACTOR_ID })],
			[
				{ ...installA, availableVersion: '1.1.0', loopName: 'Aardvark' },
				{ ...installB, availableVersion: '1.0.0', loopName: 'Bear' },
			],
		]

		const res = await app.request(
			new Request(`http://x/api/installed-loops?workspaceId=${workspaceId}`),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.installs).toHaveLength(2)
		expect(body.installs[0]).toMatchObject({
			id: installA.id,
			installedVersion: '1.0.0',
			availableVersion: '1.1.0',
			loopName: 'Aardvark',
			isLocked: true,
			hasUpdate: true,
		})
		expect(body.installs[1]).toMatchObject({
			id: installB.id,
			isLocked: false,
			hasUpdate: false,
		})
	})

	it('returns 403 when the caller is not a member of the target workspace', async () => {
		const { app, mockResults } = setup()
		const workspaceId = randomUUID()
		mockResults.selectQueue = [[]]
		const res = await app.request(
			new Request(`http://x/api/installed-loops?workspaceId=${workspaceId}`),
		)
		expect(res.status).toBe(403)
	})

	it('returns 400 when workspaceId is missing', async () => {
		const { app } = setup()
		const res = await app.request(new Request('http://x/api/installed-loops'))
		expect(res.status).toBe(400)
	})

	it('returns 400 when workspaceId is not a UUID', async () => {
		const { app } = setup()
		const res = await app.request(
			new Request('http://x/api/installed-loops?workspaceId=not-a-uuid'),
		)
		expect(res.status).toBe(400)
	})
})
