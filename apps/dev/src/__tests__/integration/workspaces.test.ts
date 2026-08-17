import { randomUUID } from 'node:crypto'
import { generateApiKey } from '@maskin/auth'
import { actors, workspaceMembers, workspaces as workspacesTable } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertActor } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// PostHog is invoked as `void capturePosthogEvent(...)` from the create route.
// Spy on the module so we can assert emit-once on success and no-emit on
// rollback without hitting the live ingestion endpoint.
const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

// Wrap seedDefaultAgentActors so specific tests can inject a partial-success
// failure (agents 1-3 written, agent 4 throws) without touching the real
// production seed for the happy-path tests. The default implementation is the
// real function — only failure tests use `mockImplementationOnce`.
const { seedDefaultAgentActorsMock } = vi.hoisted(() => ({
	seedDefaultAgentActorsMock: vi.fn(),
}))
vi.mock('../../services/workspace-bootstrap', async () => {
	const actual = await vi.importActual<typeof import('../../services/workspace-bootstrap')>(
		'../../services/workspace-bootstrap',
	)
	seedDefaultAgentActorsMock.mockImplementation(
		(...args: Parameters<typeof actual.seedDefaultAgentActors>) =>
			actual.seedDefaultAgentActors(...args),
	)
	return {
		...actual,
		seedDefaultAgentActors: seedDefaultAgentActorsMock,
	}
})

const { default: workspacesRoutes } = await import('../../routes/workspaces')
const { SeedAgentError } = await import('../../services/workspace-bootstrap')

const DEFAULT_AGENT_NAMES = [
	'Workspace Coach',
	'Chief of Staff',
	'Workspace Driver',
	'Strategist',
	'Insights Triage Agent',
	'Research Agent',
]

function createApp() {
	return createIntegrationApp({ path: '/api/workspaces', module: workspacesRoutes })
}

async function agentNamesFor(workspaceId: string): Promise<string[]> {
	const rows = await db
		.select({ name: actors.name })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(eq(workspaceMembers.workspaceId, workspaceId))
	return rows
		.map((r) => r.name)
		.filter((n) => DEFAULT_AGENT_NAMES.includes(n))
		.sort()
}

async function memberActorIdsFor(workspaceId: string): Promise<string[]> {
	const rows = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.workspaceId, workspaceId))
	return rows.map((r) => r.actorId).sort()
}

describe('Workspaces Integration', () => {
	beforeEach(() => {
		capturePosthogEventMock.mockClear()
	})

	describe('create and list', () => {
		it('creates a workspace with default settings', async () => {
			const app = createApp()

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Test Workspace' }),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.name).toBe('Test Workspace')
			expect(body.settings).toBeDefined()
			expect(body.settings.statuses).toBeDefined()
			expect(body.settings.display_names).toBeDefined()
		})

		it('lists workspaces for the current actor', async () => {
			const app = createApp()

			// Create two workspaces
			await app.request(jsonRequest('POST', '/api/workspaces', { name: 'WS 1' }))
			await app.request(jsonRequest('POST', '/api/workspaces', { name: 'WS 2' }))

			const res = await app.request(jsonGet('/api/workspaces'))
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})
	})

	describe('update settings', () => {
		it('merges settings on update', async () => {
			const app = createApp()

			// Create workspace
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Merge Test' }),
			)
			const ws = await createRes.json()

			// Update with partial settings
			const updateRes = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { display_names: { insight: 'Signal' } },
				}),
			)

			expect(updateRes.status).toBe(200)
			const updated = await updateRes.json()
			// Should have merged: new display_names + original statuses
			expect(updated.settings.display_names.insight).toBe('Signal')
			expect(updated.settings.statuses).toBeDefined()
		})

		it('returns 404 for nonexistent workspace', async () => {
			const app = createApp()
			const id = randomUUID()

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${id}`, {
					settings: { display_names: { insight: 'Signal' } },
				}),
			)

			expect(res.status).toBe(404)
		})

		it('deep-merges llm_keys so a single-provider PATCH preserves siblings', async () => {
			const app = createApp()

			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'LLM Keys Merge' }),
			)
			const ws = await createRes.json()

			await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { anthropic: 'sk-ant-AAA' } },
				}),
			)
			const second = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { openai: 'sk-oai-BBB' } },
				}),
			)
			const afterSet = await second.json()
			expect(afterSet.settings.llm_keys).toEqual({
				anthropic: 'sk-ant-AAA',
				openai: 'sk-oai-BBB',
			})

			// `null` inside llm_keys signals deletion; other providers stay.
			const third = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { anthropic: null } },
				}),
			)
			const afterDelete = await third.json()
			expect(afterDelete.settings.llm_keys).toEqual({ openai: 'sk-oai-BBB' })
		})
	})

	describe('members', () => {
		it('adds and lists members', async () => {
			const app = createApp()

			// Create workspace
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Members Test' }),
			)
			const ws = await createRes.json()

			// Create another actor to add as member
			const newActor = await insertActor(db, { name: 'New Member', email: 'member@test.com' })

			// Add member
			const addRes = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, {
					actor_id: newActor.id,
					role: 'member',
				}),
			)
			expect(addRes.status).toBe(201)

			// List members
			const listRes = await app.request(jsonGet(`/api/workspaces/${ws.id}/members`))
			expect(listRes.status).toBe(200)
			const members = await listRes.json()
			// Creator (owner) + all 6 default agents (seeded atomically inside the
			// create transaction) + the newly-added member = 8.
			expect(members).toHaveLength(8)
			const roles = members.map((m: { role: string }) => m.role).sort()
			expect(roles).toEqual([
				'member',
				'member',
				'member',
				'member',
				'member',
				'member',
				'member',
				'owner',
			])
		})

		it("changes a member's role and the change survives a reload", async () => {
			const app = createApp()

			const ws = await (
				await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Role Change' }))
			).json()

			const target = await insertActor(db, {
				name: 'Role Target',
				email: 'role-target@test.com',
			})
			await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, {
					actor_id: target.id,
					role: 'member',
				}),
			)

			const patchRes = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}/members/${target.id}`, { role: 'admin' }),
			)
			expect(patchRes.status).toBe(200)

			// Re-fetch (simulates reload) — the new role must persist.
			const listRes = await app.request(jsonGet(`/api/workspaces/${ws.id}/members`))
			const members = (await listRes.json()) as { actorId: string; role: string }[]
			expect(members.find((m) => m.actorId === target.id)?.role).toBe('admin')
		})

		it('removes a member and the removal survives a reload', async () => {
			const app = createApp()

			const ws = await (
				await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Remove Member' }))
			).json()

			const target = await insertActor(db, {
				name: 'Remove Target',
				email: 'remove-target@test.com',
			})
			await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, {
					actor_id: target.id,
					role: 'member',
				}),
			)

			const before = (await (
				await app.request(jsonGet(`/api/workspaces/${ws.id}/members`))
			).json()) as { actorId: string }[]
			expect(before.some((m) => m.actorId === target.id)).toBe(true)

			const deleteRes = await app.request(
				new Request(`http://localhost/api/workspaces/${ws.id}/members/${target.id}`, {
					method: 'DELETE',
				}),
			)
			expect(deleteRes.status).toBe(200)

			const after = (await (
				await app.request(jsonGet(`/api/workspaces/${ws.id}/members`))
			).json()) as { actorId: string }[]
			expect(after.some((m) => m.actorId === target.id)).toBe(false)
		})

		it('refuses to demote or remove the last owner', async () => {
			const app = createApp()
			const ws = await (
				await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Last Owner Guard' }))
			).json()

			// The workspace creator is the only owner — try to demote them.
			const demoteRes = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}/members/${getTestActorId()}`, {
					role: 'admin',
				}),
			)
			expect(demoteRes.status).toBe(400)

			const removeRes = await app.request(
				new Request(`http://localhost/api/workspaces/${ws.id}/members/${getTestActorId()}`, {
					method: 'DELETE',
				}),
			)
			expect(removeRes.status).toBe(400)

			// The owner is still there and still an owner.
			const members = (await (
				await app.request(jsonGet(`/api/workspaces/${ws.id}/members`))
			).json()) as { actorId: string; role: string }[]
			expect(members.find((m) => m.actorId === getTestActorId())?.role).toBe('owner')
		})
	})

	describe('default agent seeding', () => {
		it('seeds all default agents atomically inside the create transaction', async () => {
			const app = createApp()

			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Default Agents' }),
			)
			expect(createRes.status).toBe(201)
			const ws = await createRes.json()

			expect(await agentNamesFor(ws.id)).toEqual([...DEFAULT_AGENT_NAMES].sort())
		})

		it('creates two workspaces for the same creator with default agents each and no cross-contamination', async () => {
			const app = createApp()

			const first = await (
				await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Same Tenant A' }))
			).json()
			const second = await (
				await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Same Tenant B' }))
			).json()

			expect(first.id).not.toBe(second.id)
			expect(await agentNamesFor(first.id)).toEqual([...DEFAULT_AGENT_NAMES].sort())
			expect(await agentNamesFor(second.id)).toEqual([...DEFAULT_AGENT_NAMES].sort())

			// Agent actor rows are distinct between workspaces — a workspace's
			// members must not overlap another workspace's, otherwise
			// permissions/skills would leak across tenants.
			const firstAgentIds = new Set(
				(
					await db
						.select({ actorId: workspaceMembers.actorId })
						.from(workspaceMembers)
						.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
						.where(eq(workspaceMembers.workspaceId, first.id))
				)
					.map((r) => r.actorId)
					.filter((id) => id !== getTestActorId()),
			)
			const secondAgentIds = (
				await db
					.select({ actorId: workspaceMembers.actorId })
					.from(workspaceMembers)
					.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
					.where(eq(workspaceMembers.workspaceId, second.id))
			)
				.map((r) => r.actorId)
				.filter((id) => id !== getTestActorId())
			for (const id of secondAgentIds) expect(firstAgentIds.has(id)).toBe(false)
		})

		it('re-invoking the seeding path against an already-seeded workspace inserts zero new agent rows', async () => {
			const app = createApp()

			const first = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Idempotent Seed' }),
			)
			const ws = await first.json()

			const initial = await db
				.select({ actorId: workspaceMembers.actorId })
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(eq(workspaceMembers.workspaceId, ws.id))
			const initialAgents = initial.filter(() => true)

			const { seedDefaultAgentActors } = await import('../../services/workspace-bootstrap')
			await seedDefaultAgentActors(db, ws.id, getTestActorId())

			const after = await db
				.select({ actorId: workspaceMembers.actorId })
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(eq(workspaceMembers.workspaceId, ws.id))

			expect(after.length).toBe(initialAgents.length)
		})

		it('leaves three pre-existing workspaces byte-identical when a new workspace is seeded', async () => {
			// Create three workspaces with their own actor lists directly, bypassing
			// the seed path — these represent workspaces that existed before the T2
			// code path shipped.
			const preExistingIds: string[] = []
			const snapshots = new Map<string, string[]>()
			for (let i = 0; i < 3; i++) {
				const [ws] = await db
					.insert(workspacesTable)
					.values({ name: `Pre-existing ${i}`, createdBy: getTestActorId() })
					.returning()
				preExistingIds.push(ws.id)
				await db.insert(workspaceMembers).values({
					workspaceId: ws.id,
					actorId: getTestActorId(),
					role: 'owner',
				})
				// Attach a couple of arbitrary actors to make the snapshot non-trivial.
				for (let k = 0; k < 2; k++) {
					const extra = await insertActor(db, {
						name: `Legacy Actor ${i}-${k}`,
						email: `legacy-${i}-${k}@test.com`,
					})
					await db.insert(workspaceMembers).values({
						workspaceId: ws.id,
						actorId: extra.id,
						role: 'member',
					})
				}
				snapshots.set(ws.id, await memberActorIdsFor(ws.id))
			}

			// Now run the new seed path against a fresh workspace via the route.
			const app = createApp()
			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Fresh Seeded' }),
			)
			expect(res.status).toBe(201)

			// Every pre-existing workspace's member list is byte-identical to its
			// snapshot — the new code path didn't touch them.
			for (const id of preExistingIds) {
				const now = await memberActorIdsFor(id)
				expect(now).toEqual(snapshots.get(id))
			}
		})

		it('returns 500 naming the failed agent and rolls back workspace/member/actor rows when seeding fails on the 4th agent', async () => {
			// Simulate the "fourth agent fails" case: the seed helper writes agents
			// 1-3 into the caller's transaction, then throws SeedAgentError for
			// insights_triage. The route's `db.transaction` must roll back every
			// row — including the three partial actor inserts.
			seedDefaultAgentActorsMock.mockImplementationOnce(async (tx, wsId, createdBy) => {
				for (const name of ['Workspace Coach', 'Workspace Driver', 'Strategist']) {
					const [created] = await tx
						.insert(actors)
						.values({
							type: 'agent',
							name,
							apiKey: generateApiKey().key,
							createdBy: createdBy as string,
						})
						.returning()
					if (created) {
						await tx.insert(workspaceMembers).values({
							workspaceId: wsId as string,
							actorId: created.id,
							role: 'member',
						})
					}
				}
				throw new SeedAgentError('insights_triage', new Error('mock failure on 4th agent'))
			})

			const workspacesBefore = await db.select({ id: workspacesTable.id }).from(workspacesTable)
			const membersBefore = await db
				.select({ actorId: workspaceMembers.actorId, workspaceId: workspaceMembers.workspaceId })
				.from(workspaceMembers)
			const actorsBefore = await db.select({ id: actors.id }).from(actors)

			const app = createApp()
			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Should Rollback' }),
			)

			expect(res.status).toBe(500)
			const body = (await res.json()) as {
				error: { code: string; message: string; details?: { field: string; message: string }[] }
			}
			expect(body.error.code).toBe('INTERNAL_ERROR')
			expect(body.error.message).toContain('insights_triage')
			expect(body.error.details).toEqual(
				expect.arrayContaining([{ field: 'agent_id', message: 'insights_triage' }]),
			)

			// No workspace row, no member row, no actor row survived the aborted request.
			const workspacesAfter = await db.select({ id: workspacesTable.id }).from(workspacesTable)
			expect(workspacesAfter.length).toBe(workspacesBefore.length)

			const membersAfter = await db
				.select({ actorId: workspaceMembers.actorId, workspaceId: workspaceMembers.workspaceId })
				.from(workspaceMembers)
			expect(membersAfter.length).toBe(membersBefore.length)

			const actorsAfter = await db.select({ id: actors.id }).from(actors)
			expect(actorsAfter.length).toBe(actorsBefore.length)

			// PostHog `workspace_created` must NOT fire — the workspace never
			// committed. Emitting on the rollback path would poison the activation
			// cohort with phantom workspaces.
			expect(capturePosthogEventMock).not.toHaveBeenCalled()
		})

		it('emits the workspace_created PostHog event exactly once per successful creation with workspace_id in properties', async () => {
			const app = createApp()

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'PostHog Emit' }),
			)
			expect(res.status).toBe(201)
			const ws = await res.json()

			expect(capturePosthogEventMock).toHaveBeenCalledOnce()
			const [event, distinctId, properties] = capturePosthogEventMock.mock.calls[0] as [
				string,
				string,
				Record<string, unknown>,
			]
			expect(event).toBe('workspace_created')
			expect(distinctId).toBe(ws.id)
			expect(properties.workspace_id).toBe(ws.id)
		})
	})

	describe('default chat agent', () => {
		async function chiefOfStaffIdFor(workspaceId: string): Promise<string | undefined> {
			const rows = await db
				.select({ actorId: actors.id, name: actors.name })
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(eq(workspaceMembers.workspaceId, workspaceId))
			return rows.find((r) => r.name === 'Chief of Staff')?.actorId
		}

		it('defaults a newly created workspace to its own Chief of Staff actor', async () => {
			const app = createApp()

			const res = await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Default CoS' }))
			expect(res.status).toBe(201)
			const ws = await res.json()

			const chiefId = await chiefOfStaffIdFor(ws.id)
			expect(chiefId).toBeDefined()
			expect(ws.settings.default_agent_id).toBe(chiefId)
		})

		it('does not overwrite an explicit default_agent_id supplied at creation', async () => {
			const app = createApp()
			const explicitAgentId = randomUUID()

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', {
					name: 'Explicit Default',
					settings: { default_agent_id: explicitAgentId },
				}),
			)
			expect(res.status).toBe(201)
			const ws = await res.json()

			expect(ws.settings.default_agent_id).toBe(explicitAgentId)

			const [row] = await db
				.select({ settings: workspacesTable.settings })
				.from(workspacesTable)
				.where(eq(workspacesTable.id, ws.id))
			expect((row?.settings as { default_agent_id?: string })?.default_agent_id).toBe(
				explicitAgentId,
			)
		})
	})
})
