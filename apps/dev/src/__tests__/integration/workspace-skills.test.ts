import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, agentSkills, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import AdmZip from 'adm-zip'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import {
	AgentStorageManager,
	workspaceSkillFileKey,
	workspaceSkillKey,
} from '../../services/agent-storage'
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
		async listWithMetadata(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, buf]) => ({ key, size: buf.length }))
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

			// SKILL.md landed at the UUID-keyed S3 path.
			const key = workspaceSkillKey(workspaceId, created.id)
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

			const createRes = await app.request(
				jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
					name: 'deploy-prod',
					content: SKILL_BODY,
				}),
			)
			const created = await createRes.json()

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

			const key = workspaceSkillKey(workspaceId, created.id)
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

	describe('batch attach', () => {
		it('attaches multiple skills to an agent in a single request', async () => {
			const app = createSkillsApp(storage)
			const agent = await insertActor(db, { type: 'agent', name: 'Ops Bot' })
			await db.insert(workspaceMembers).values({
				workspaceId,
				actorId: agent.id,
				role: 'member',
			})

			const skillA = await (
				await app.request(
					jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
						name: 'deploy-prod',
						content: SKILL_BODY,
					}),
				)
			).json()
			const skillB = await (
				await app.request(
					jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
						name: 'rollback-prod',
						content: SKILL_BODY,
					}),
				)
			).json()

			const batchRes = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/workspace-skills/batch`, {
					workspaceSkillIds: [skillA.id, skillB.id],
				}),
			)
			expect(batchRes.status).toBe(200)
			const results = await batchRes.json()
			expect(results).toHaveLength(2)
			expect(results.every((r: { success: boolean }) => r.success)).toBe(true)

			const listRes = await app.request(jsonGet(`/api/actors/${agent.id}/workspace-skills`))
			const list = await listRes.json()
			expect(list.map((s: { id: string }) => s.id).sort()).toEqual([skillA.id, skillB.id].sort())

			// Exactly one `attached` event per skill, even though the batch runs as
			// a single call server-side.
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
			expect(attachEvents).toHaveLength(2)
		})

		it('is idempotent and reports partial failures without failing the whole batch', async () => {
			const app = createSkillsApp(storage)
			const agent = await insertActor(db, { type: 'agent', name: 'Ops Bot' })
			await db.insert(workspaceMembers).values({
				workspaceId,
				actorId: agent.id,
				role: 'member',
			})

			const skill = await (
				await app.request(
					jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
						name: 'deploy-prod',
						content: SKILL_BODY,
					}),
				)
			).json()

			// Attach once up front so the batch call re-attaches it (idempotent branch).
			await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/workspace-skills`, {
					workspaceSkillId: skill.id,
				}),
			)

			const missingSkillId = '00000000-0000-0000-0000-0000000000ff'
			const batchRes = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/workspace-skills/batch`, {
					workspaceSkillIds: [skill.id, missingSkillId],
				}),
			)

			expect(batchRes.status).toBe(200)
			const results = await batchRes.json()
			expect(results).toHaveLength(2)
			expect(results[0].success).toBe(true)
			expect(results[0].skill.id).toBe(skill.id)
			expect(results[1].success).toBe(false)
			expect(results[1].workspaceSkillId).toBe(missingSkillId)
			expect(results[1].error).toContain('not found')

			// Still only one `attached` event — the pre-attach plus the idempotent
			// batch re-attach didn't double up.
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

		it('returns a per-skill error when attaching across workspaces', async () => {
			const app = createSkillsApp(storage)
			const workspaceB = await insertWorkspace(db, getTestActorId())

			const skill = await (
				await app.request(
					jsonRequest('POST', `/api/workspaces/${workspaceId}/skills`, {
						name: 'deploy-prod',
						content: SKILL_BODY,
					}),
				)
			).json()

			// Agent is only a member of workspace B, not the skill's workspace.
			const agent = await insertActor(db, { type: 'agent', name: 'Outsider' })
			await db.insert(workspaceMembers).values({
				workspaceId: workspaceB.id,
				actorId: agent.id,
				role: 'member',
			})

			const batchRes = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/workspace-skills/batch`, {
					workspaceSkillIds: [skill.id],
				}),
			)
			expect(batchRes.status).toBe(200)
			const results = await batchRes.json()
			expect(results[0].success).toBe(false)
			expect(results[0].error).toContain("outside the skill's workspace")
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
			expect(storage._store.has(workspaceSkillKey(workspaceId, skill.id))).toBe(false)
		})
	})

	describe('folder skill upload', () => {
		const ANTHROPIC_SKILL_MD =
			'---\nname: docx\ndescription: Generate Microsoft Word documents\n---\n\nDocx skill body.'

		function uploadRequest(name: string, body: Buffer, query = '') {
			const formData = new FormData()
			formData.append('file', new File([body], name))
			return new Request(`http://localhost/api/workspaces/${workspaceId}/skills/upload${query}`, {
				method: 'POST',
				body: formData,
			})
		}

		it('uploads an Anthropic-shaped docx bundle end-to-end', async () => {
			const app = createSkillsApp(storage)
			const zip = new AdmZip()
			zip.addFile('docx/SKILL.md', Buffer.from(ANTHROPIC_SKILL_MD, 'utf-8'))
			zip.addFile('docx/reference/style.md', Buffer.from('Style guide', 'utf-8'))
			zip.addFile('docx/scripts/run.py', Buffer.from('print("hi")', 'utf-8'))

			const res = await app.request(uploadRequest('docx.zip', zip.toBuffer()))
			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.name).toBe('docx')
			expect(body.isFolder).toBe(true)
			expect(body.fileCount).toBe(3)
			expect(body.isValid).toBe(true)
			expect(body.error).toBeNull()

			// Row landed with the folder flag set.
			const [row] = await db.select().from(workspaceSkills).where(eq(workspaceSkills.id, body.id))
			expect(row?.isFolder).toBe(true)
			expect(row?.fileCount).toBe(3)

			// Every bundled file is visible under the skill prefix.
			expect(storage._store.has(workspaceSkillKey(workspaceId, body.id))).toBe(true)
			expect(
				storage._store.has(workspaceSkillFileKey(workspaceId, body.id, 'reference/style.md')),
			).toBe(true)
			expect(
				storage._store.has(workspaceSkillFileKey(workspaceId, body.id, 'scripts/run.py')),
			).toBe(true)
		})

		it('uploads a single SKILL.md via the same endpoint and marks it non-folder', async () => {
			const app = createSkillsApp(storage)
			const res = await app.request(
				uploadRequest('docx.md', Buffer.from(ANTHROPIC_SKILL_MD, 'utf-8')),
			)
			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.isFolder).toBe(false)
			expect(body.fileCount).toBeNull()

			const [row] = await db.select().from(workspaceSkills).where(eq(workspaceSkills.id, body.id))
			expect(row?.isFolder).toBe(false)
			expect(row?.fileCount).toBeNull()
		})

		it('replaces a folder skill in place and clears stale bundled files', async () => {
			const app = createSkillsApp(storage)

			const firstZip = new AdmZip()
			firstZip.addFile('docx/SKILL.md', Buffer.from(ANTHROPIC_SKILL_MD, 'utf-8'))
			firstZip.addFile('docx/reference/old.md', Buffer.from('old', 'utf-8'))
			const firstRes = await app.request(uploadRequest('docx.zip', firstZip.toBuffer()))
			const first = await firstRes.json()
			expect(
				storage._store.has(workspaceSkillFileKey(workspaceId, first.id, 'reference/old.md')),
			).toBe(true)

			// Re-upload with a different layout — `old.md` should be gone.
			const secondZip = new AdmZip()
			secondZip.addFile('docx/SKILL.md', Buffer.from(ANTHROPIC_SKILL_MD, 'utf-8'))
			secondZip.addFile('docx/reference/new.md', Buffer.from('new', 'utf-8'))
			const secondRes = await app.request(
				uploadRequest('docx.zip', secondZip.toBuffer(), `?skillId=${first.id}`),
			)
			expect(secondRes.status).toBe(201)
			expect(
				storage._store.has(workspaceSkillFileKey(workspaceId, first.id, 'reference/old.md')),
			).toBe(false)
			expect(
				storage._store.has(workspaceSkillFileKey(workspaceId, first.id, 'reference/new.md')),
			).toBe(true)
		})

		it('rejects a malformed bundle on replace and leaves the existing bundle intact', async () => {
			const app = createSkillsApp(storage)
			const zip = new AdmZip()
			zip.addFile('docx/SKILL.md', Buffer.from(ANTHROPIC_SKILL_MD, 'utf-8'))
			zip.addFile('docx/reference/keep.md', Buffer.from('keep me', 'utf-8'))
			const firstRes = await app.request(uploadRequest('docx.zip', zip.toBuffer()))
			expect(firstRes.status).toBe(201)
			const first = await firstRes.json()

			// Replace with a zip that has no SKILL.md — must be rejected without
			// touching the row or the stored bundle.
			const badZip = new AdmZip()
			badZip.addFile('README.md', Buffer.from('not a skill', 'utf-8'))
			const res = await app.request(
				uploadRequest('docx.zip', badZip.toBuffer(), `?skillId=${first.id}`),
			)
			expect(res.status).toBe(400)

			expect(storage._store.has(workspaceSkillKey(workspaceId, first.id))).toBe(true)
			expect(
				storage._store.has(workspaceSkillFileKey(workspaceId, first.id, 'reference/keep.md')),
			).toBe(true)
			const [row] = await db.select().from(workspaceSkills).where(eq(workspaceSkills.id, first.id))
			expect(row?.isValid).toBe(true)
			expect(row?.fileCount).toBe(2)
			expect(row?.content).toContain('Docx skill body.')
		})
	})

	describe('folder skill download', () => {
		const ANTHROPIC_SKILL_MD =
			'---\nname: docx\ndescription: Generate Microsoft Word documents\n---\n\nDocx skill body.'

		function uploadRequest(name: string, body: Buffer, query = '') {
			const formData = new FormData()
			formData.append('file', new File([body], name))
			return new Request(`http://localhost/api/workspaces/${workspaceId}/skills/upload${query}`, {
				method: 'POST',
				body: formData,
			})
		}

		function downloadRequest(skillId: string) {
			return new Request(
				`http://localhost/api/workspaces/${workspaceId}/skills/${skillId}/download`,
			)
		}

		it('round-trips through T2 upload — download zip re-uploads cleanly with the same file count', async () => {
			const app = createSkillsApp(storage)

			// Upload an Anthropic-shaped bundle so the row + S3 prefix is realistic.
			const zip = new AdmZip()
			zip.addFile('docx/SKILL.md', Buffer.from(ANTHROPIC_SKILL_MD, 'utf-8'))
			zip.addFile('docx/reference/style.md', Buffer.from('Style guide', 'utf-8'))
			zip.addFile('docx/scripts/run.py', Buffer.from('print("hi")', 'utf-8'))
			const uploadRes = await app.request(uploadRequest('docx.zip', zip.toBuffer()))
			expect(uploadRes.status).toBe(201)
			const uploaded = await uploadRes.json()
			expect(uploaded.isFolder).toBe(true)
			expect(uploaded.fileCount).toBe(3)

			// Download the bundle back as a zip.
			const downloadRes = await app.request(downloadRequest(uploaded.id))
			expect(downloadRes.status).toBe(200)
			expect(downloadRes.headers.get('Content-Type')).toBe('application/zip')
			expect(downloadRes.headers.get('Content-Disposition')).toContain('filename="docx.zip"')
			const zipBuffer = Buffer.from(await downloadRes.arrayBuffer())

			// Sanity-check the response zip structure.
			const downloaded = new AdmZip(zipBuffer)
			const entryNames = downloaded.getEntries().map((e) => e.entryName)
			expect(entryNames.sort()).toEqual(['SKILL.md', 'reference/style.md', 'scripts/run.py'].sort())

			// Re-upload the downloaded zip as a Replace of the same skill — same
			// `file_count`, still folder skill. A round-trip re-upload keeps the
			// SKILL.md frontmatter `name: docx` unchanged, so uploading it as a
			// brand-new skill (no `?skillId=`) would collide with the original on
			// the workspace's unique name constraint. Replacing is also the real
			// user flow this proves: Download .zip → edit → Replace.
			// This is the DoD round-trip: the downloaded zip must re-upload cleanly.
			const reuploadRes = await app.request(
				uploadRequest('docx-roundtrip.zip', zipBuffer, `?skillId=${uploaded.id}`),
			)
			expect(reuploadRes.status).toBe(201)
			const reuploaded = await reuploadRes.json()
			expect(reuploaded.isFolder).toBe(true)
			expect(reuploaded.fileCount).toBe(3)
			expect(reuploaded.isValid).toBe(true)
			expect(reuploaded.error).toBeNull()
		})

		it('returns 404 for single-file skills', async () => {
			const app = createSkillsApp(storage)
			const uploadRes = await app.request(
				uploadRequest('docx.md', Buffer.from(ANTHROPIC_SKILL_MD, 'utf-8')),
			)
			const uploaded = await uploadRes.json()
			expect(uploaded.isFolder).toBe(false)

			const downloadRes = await app.request(downloadRequest(uploaded.id))
			expect(downloadRes.status).toBe(404)
		})

		it('returns 404 when the skill does not exist', async () => {
			const app = createSkillsApp(storage)
			const downloadRes = await app.request(downloadRequest('00000000-0000-0000-0000-0000ddddffff'))
			expect(downloadRes.status).toBe(404)
		})
	})
})
