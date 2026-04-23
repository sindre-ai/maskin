import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, agentSkills, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { AgentStorageManager, workspaceSkillKey } from '../../services/agent-storage'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: workspaceSkillsRoutes } = await import('../../routes/workspace-skills')
const { default: agentSkillAttachmentsRoutes } = await import(
	'../../routes/agent-skill-attachments'
)

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		agentStorage: AgentStorageManager
	}
}

/**
 * Minimal in-memory StorageProvider so the integration test exercises the real
 * S3-write path in the routes without needing SeaweedFS running in CI.
 */
function createMemoryStorage(): StorageProvider & { _store: Map<string, Buffer> } {
	const store = new Map<string, Buffer>()
	return {
		_store: store,
		async put(key, data) {
			if (Buffer.isBuffer(data)) {
				store.set(key, data)
			} else if (data instanceof Uint8Array) {
				store.set(key, Buffer.from(data))
			} else {
				throw new Error('Streaming put not supported in memory storage')
			}
		},
		async get(key) {
			const buf = store.get(key)
			if (!buf) throw new Error(`Not found: ${key}`)
			return buf
		},
		async list(prefix) {
			return [...store.keys()].filter((k) => k.startsWith(prefix))
		},
		async delete(key) {
			store.delete(key)
		},
		async exists(key) {
			return store.has(key)
		},
		async ensureBucket() {
			// no-op
		},
	}
}

function createSkillsApp(storage: StorageProvider, actorId = getTestActorId()) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})

	const agentStorage = new AgentStorageManager(storage, db)

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('agentStorage', agentStorage)
		await next()
	})

	app.route('/api/workspaces', workspaceSkillsRoutes)
	app.route('/api/actors', agentSkillAttachmentsRoutes)

	return app
}

const SKILL_BODY = '---\nname: deploy-prod\ndescription: Ship to prod\n---\n\nRun the deploy.'

describe('Workspace Skills Integration', () => {
	let workspaceId: string
	let storage: ReturnType<typeof createMemoryStorage>

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		storage = createMemoryStorage()
	})

	describe('CRUD lifecycle', () => {
		it('creates a skill, writes SKILL.md to storage, and exposes it via GET', async () => {
			const app = createSkillsApp(storage)

			const createRes = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
					name: 'deploy-prod',
					content: SKILL_BODY,
				}),
			)
			expect(createRes.status).toBe(201)
			const created = await createRes.json()
			expect(created.name).toBe('deploy-prod')
			expect(created.description).toBe('Ship to prod')
			expect(created.sizeBytes).toBe(Buffer.byteLength(SKILL_BODY, 'utf-8'))

			// SKILL.md landed at the canonical S3 key.
			const key = workspaceSkillKey(workspaceId, 'deploy-prod')
			expect(storage._store.has(key)).toBe(true)
			expect(storage._store.get(key)?.toString('utf-8')).toBe(SKILL_BODY)

			// Listing returns a lightweight row (no content).
			const listRes = await app.request(jsonGet(`/api/workspaces/${workspaceId}/skills`))
			expect(listRes.status).toBe(200)
			const list = await listRes.json()
			expect(list).toHaveLength(1)
			expect(list[0].name).toBe('deploy-prod')
			expect(list[0].content).toBeUndefined()

			// GET-by-name returns full content.
			const getRes = await app.request(jsonGet(`/api/workspaces/${workspaceId}/skills/deploy-prod`))
			expect(getRes.status).toBe(200)
			const fetched = await getRes.json()
			expect(fetched.content).toBe(SKILL_BODY)

			// `events` row was written for the create.
			const rows = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.workspaceId, workspaceId),
						eq(events.entityType, 'workspace_skill'),
						eq(events.action, 'created'),
					),
				)
			expect(rows).toHaveLength(1)
		})

		it('updates skill content and re-fetching returns the new body', async () => {
			const app = createSkillsApp(storage)

			await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
					name: 'deploy-prod',
					content: SKILL_BODY,
				}),
			)

			const newContent =
				'---\nname: deploy-prod\ndescription: Ship to prod v2\n---\n\nRun the deploy carefully.'
			const updateRes = await app.request(
				jsonRequest('PUT', `/api/workspaces/${workspaceId}/skills/deploy-prod`, {
					content: newContent,
				}),
			)
			expect(updateRes.status).toBe(200)
			const updated = await updateRes.json()
			expect(updated.content).toBe(newContent)
			expect(updated.description).toBe('Ship to prod v2')

			const key = workspaceSkillKey(workspaceId, 'deploy-prod')
			expect(storage._store.get(key)?.toString('utf-8')).toBe(newContent)

			const getRes = await app.request(jsonGet(`/api/workspaces/${workspaceId}/skills/deploy-prod`))
			const fetched = await getRes.json()
			expect(fetched.content).toBe(newContent)
		})

		it('returns 409 when creating a second skill with the same name', async () => {
			const app = createSkillsApp(storage)

			const first = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
					name: 'deploy-prod',
					content: SKILL_BODY,
				}),
			)
			expect(first.status).toBe(201)

			const second = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
					name: 'deploy-prod',
					content: SKILL_BODY,
				}),
			)
			expect(second.status).toBe(409)
		})
	})

	describe('attach / list / detach', () => {
		it('attaches a skill to an agent, lists the attachment, and detaches it', async () => {
			const app = createSkillsApp(storage)
			const agent = await insertActor(db, { type: 'agent', name: 'Ops Bot' })
			// Agent must share the workspace the skill belongs to.
			await db.insert(workspaceMembers).values({
				workspaceId,
				actorId: agent.id,
				role: 'member',
			})

			const createRes = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
					name: 'deploy-prod',
					content: SKILL_BODY,
				}),
			)
			const skill = await createRes.json()

			// Attach
			const attachRes = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/workspace-skills`, {
					workspaceSkillId: skill.id,
				}),
			)
			expect(attachRes.status).toBe(200)
			const attached = await attachRes.json()
			expect(attached.id).toBe(skill.id)
			expect(attached.attachedAt).toBeTruthy()

			// Re-attach is idempotent (same 200, same row)
			const reAttachRes = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/workspace-skills`, {
					workspaceSkillId: skill.id,
				}),
			)
			expect(reAttachRes.status).toBe(200)

			// List
			const listRes = await app.request(jsonGet(`/api/actors/${agent.id}/workspace-skills`))
			expect(listRes.status).toBe(200)
			const list = await listRes.json()
			expect(list).toHaveLength(1)
			expect(list[0].id).toBe(skill.id)

			// Detach
			const detachRes = await app.request(
				jsonRequest('DELETE', `/api/actors/${agent.id}/workspace-skills/${skill.id}`),
			)
			expect(detachRes.status).toBe(200)

			const afterList = await app.request(jsonGet(`/api/actors/${agent.id}/workspace-skills`))
			const afterRows = await afterList.json()
			expect(afterRows).toHaveLength(0)

			// Only ONE `attached` event was recorded even though we attached twice.
			const attachEvents = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.workspaceId, workspaceId),
						eq(events.entityType, 'agent_skill'),
						eq(events.action, 'attached'),
					),
				)
			expect(attachEvents).toHaveLength(1)
		})

		it('returns 400 when attaching a skill across workspaces', async () => {
			const app = createSkillsApp(storage)

			// Workspace A is `workspaceId` (caller is owner from beforeEach).
			const workspaceB = await insertWorkspace(db, getTestActorId())

			const createRes = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
					name: 'deploy-prod',
					content: SKILL_BODY,
				}),
			)
			const skill = await createRes.json()

			// Agent is only a member of workspace B, not A.
			const agent = await insertActor(db, { type: 'agent', name: 'Outsider' })
			await db.insert(workspaceMembers).values({
				workspaceId: workspaceB.id,
				actorId: agent.id,
				role: 'member',
			})

			const attachRes = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/workspace-skills`, {
					workspaceSkillId: skill.id,
				}),
			)
			expect(attachRes.status).toBe(400)
		})
	})

	describe('delete cascade', () => {
		it('removes matching agent_skills rows when a workspace_skills row is deleted', async () => {
			const app = createSkillsApp(storage)
			const agent = await insertActor(db, { type: 'agent', name: 'Cascade Bot' })
			await db.insert(workspaceMembers).values({
				workspaceId,
				actorId: agent.id,
				role: 'member',
			})

			const createRes = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
					name: 'deploy-prod',
					content: SKILL_BODY,
				}),
			)
			const skill = await createRes.json()

			await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/workspace-skills`, {
					workspaceSkillId: skill.id,
				}),
			)

			// Sanity check: the attachment exists.
			const before = await db
				.select()
				.from(agentSkills)
				.where(eq(agentSkills.workspaceSkillId, skill.id))
			expect(before).toHaveLength(1)

			// Delete the skill.
			const deleteRes = await app.request(
				jsonRequest('DELETE', `/api/workspaces/${workspaceId}/skills/deploy-prod`),
			)
			expect(deleteRes.status).toBe(200)

			// The DB row is gone.
			const remainingSkills = await db
				.select()
				.from(workspaceSkills)
				.where(eq(workspaceSkills.id, skill.id))
			expect(remainingSkills).toHaveLength(0)

			// And the attachment cascaded away.
			const remainingAttachments = await db
				.select()
				.from(agentSkills)
				.where(eq(agentSkills.workspaceSkillId, skill.id))
			expect(remainingAttachments).toHaveLength(0)

			// S3 object was deleted.
			expect(storage._store.has(workspaceSkillKey(workspaceId, 'deploy-prod'))).toBe(false)
		})
	})
})
