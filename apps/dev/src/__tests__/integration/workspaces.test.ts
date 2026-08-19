import { randomUUID } from 'node:crypto'
import { workspaceMembers, workspaces as workspacesTable } from '@maskin/db/schema'
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

const { default: workspacesRoutes } = await import('../../routes/workspaces')

function createApp() {
	return createIntegrationApp({ path: '/api/workspaces', module: workspacesRoutes })
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
			// Creator (owner) + the newly-added member = 2. No default agents are
			// auto-seeded on workspace creation.
			expect(members).toHaveLength(2)
			const roles = members.map((m: { role: string }) => m.role).sort()
			expect(roles).toEqual(['member', 'owner'])
		})
	})

	describe('no default agent seeding', () => {
		it('creates a workspace with only the creator as a member — no agents auto-seeded', async () => {
			const app = createApp()

			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'No Default Agents' }),
			)
			expect(createRes.status).toBe(201)
			const ws = await createRes.json()

			const memberIds = await memberActorIdsFor(ws.id)
			expect(memberIds).toEqual([getTestActorId()])
		})

		it('leaves three pre-existing workspaces byte-identical when a new workspace is created', async () => {
			// Create three workspaces with their own actor lists directly, bypassing
			// the create route — these represent workspaces that existed before.
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

			// Now create a fresh workspace via the route.
			const app = createApp()
			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Fresh Workspace' }),
			)
			expect(res.status).toBe(201)

			// Every pre-existing workspace's member list is byte-identical to its
			// snapshot — creating a new workspace didn't touch them.
			for (const id of preExistingIds) {
				const now = await memberActorIdsFor(id)
				expect(now).toEqual(snapshots.get(id))
			}
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
		it('leaves default_agent_id unset for a newly created workspace', async () => {
			const app = createApp()

			const res = await app.request(jsonRequest('POST', '/api/workspaces', { name: 'No CoS' }))
			expect(res.status).toBe(201)
			const ws = await res.json()

			expect(ws.settings.default_agent_id).toBeUndefined()
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
