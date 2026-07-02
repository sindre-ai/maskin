import { randomUUID } from 'node:crypto'
import { actors, workspaceMembers, workspaces as workspacesTable } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertActor } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')

const DEFAULT_AGENT_NAMES = [
	'Workspace Coach',
	'Workspace Driver',
	'Strategist',
	'Insights Triage Agent',
	'Research Agent',
]

function createApp() {
	return createIntegrationApp({ path: '/api/workspaces', module: workspacesRoutes })
}

describe('Workspaces Integration', () => {
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
			// Creator (owner) + all 5 default agents (seeded atomically inside the
			// create transaction) + the newly-added member = 7.
			expect(members).toHaveLength(7)
			const roles = members.map((m: { role: string }) => m.role).sort()
			expect(roles).toEqual(['member', 'member', 'member', 'member', 'member', 'member', 'owner'])
		})
	})

	describe('default agent seeding', () => {
		it('seeds all 5 default agents atomically inside the create transaction', async () => {
			const app = createApp()

			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Default Agents' }),
			)
			expect(createRes.status).toBe(201)
			const ws = await createRes.json()

			const seededNames = await db
				.select({ name: actors.name })
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(eq(workspaceMembers.workspaceId, ws.id))

			const agentNames = seededNames
				.map((r) => r.name)
				.filter((n) => DEFAULT_AGENT_NAMES.includes(n))
				.sort()
			expect(agentNames).toEqual([...DEFAULT_AGENT_NAMES].sort())
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

		it('rolls back the workspace, member, and any partial actor rows when the seed helper throws', async () => {
			const { seedDefaultAgentActors, SeedAgentError } = await import(
				'../../services/workspace-bootstrap'
			)

			const workspacesBefore = await db.select().from(workspacesTable)
			const coachesBefore = await db.select().from(actors).where(eq(actors.name, 'Workspace Coach'))

			let caught: unknown = null
			try {
				await db.transaction(async (tx) => {
					const [ws] = await tx
						.insert(workspacesTable)
						.values({ name: 'Should Rollback', createdBy: getTestActorId() })
						.returning()
					if (!ws) throw new Error('workspace insert returned no row')
					await tx.insert(workspaceMembers).values({
						workspaceId: ws.id,
						actorId: getTestActorId(),
						role: 'owner',
					})
					// Seed the first agents, then throw partway through — this is how
					// the route also aborts: SeedAgentError bubbles out of the tx and
					// Postgres rolls back every write, including the actor rows the
					// helper already inserted.
					await seedDefaultAgentActors(tx, ws.id, getTestActorId())
					throw new SeedAgentError('workspace_driver', new Error('forced rollback'))
				})
			} catch (err) {
				caught = err
			}

			expect(caught).toBeInstanceOf(SeedAgentError)

			// No workspace row, no member row, and no actor rows survived.
			const workspacesAfter = await db.select().from(workspacesTable)
			expect(workspacesAfter.length).toBe(workspacesBefore.length)
			const coachesAfter = await db.select().from(actors).where(eq(actors.name, 'Workspace Coach'))
			expect(coachesAfter.length).toBe(coachesBefore.length)
		})
	})
})
