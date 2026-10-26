import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	fileProposalChanges,
	fileProposals,
	files,
	relationships,
	workspaceMembers,
} from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { reserveRoundSlot, resetRoundLimiterForTests } from '../../lib/file-comment-round-limiter'
import { fileStorageKey } from '../../lib/file-urls'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const capture = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capture,
	warnIfPosthogKeyUnset: vi.fn(),
}))

const { default: fileProposalsRoutes } = await import('../../routes/file-proposals')

const DOC = '# Plan\n\nWe ship on Friday.\n\nThe budget is small.\n\nWe ship on Monday.\n'

/** Storage that keeps bytes in memory. */
function createMemoryStorage() {
	const objects = new Map<string, Buffer>()
	const storage = {
		put: async (key: string, data: Buffer) => {
			objects.set(key, Buffer.from(data))
		},
		get: async (key: string) => {
			const bytes = objects.get(key)
			if (!bytes) throw new Error(`missing ${key}`)
			return bytes
		},
	} as unknown as StorageProvider
	return { storage, objects }
}

function createApp(storage: StorageProvider, actorId: string, opts: { sessionId?: string } = {}) {
	const app = new OpenAPIHono<{ Variables: { db: Database; actorId: string } }>({
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
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('notifyBridge' as never, {} as PgNotifyBridge as never)
		c.set('storageProvider' as never, storage as never)
		if (opts.sessionId) c.set('maskinSessionId' as never, opts.sessionId as never)
		await next()
	})
	app.route('/api/files', fileProposalsRoutes as never)
	return app
}

async function insertFile(
	workspaceId: string,
	mem: ReturnType<typeof createMemoryStorage>,
	overrides: { name?: string; mimeType?: string; text?: string } = {},
) {
	const id = randomUUID()
	const bytes = Buffer.from(overrides.text ?? DOC)
	const storageKey = fileStorageKey(workspaceId, id)
	mem.objects.set(storageKey, bytes)
	const [row] = await db
		.insert(files)
		.values({
			id,
			workspaceId,
			name: overrides.name ?? 'plan.md',
			mimeType: overrides.mimeType ?? 'text/markdown',
			sizeBytes: bytes.byteLength,
			storageKey,
			createdBy: getTestActorId(),
		})
		.returning()
	if (!row) throw new Error('file insert failed')
	return row
}

async function attach(fileId: string, objectId: string) {
	await db.insert(relationships).values({
		sourceType: 'object',
		sourceId: objectId,
		targetType: 'file',
		targetId: fileId,
		type: 'attached',
		createdBy: getTestActorId(),
	})
}

const submit = (app: ReturnType<typeof createApp>, fileId: string, body: unknown) =>
	app.request(jsonRequest('POST', `/api/files/${fileId}/proposals`, body))

const proposalCount = async (fileId: string) =>
	(await db.select().from(fileProposals).where(eq(fileProposals.fileId, fileId))).length

describe('File proposals (integration)', () => {
	let actorId: string
	let workspaceId: string
	let mem: ReturnType<typeof createMemoryStorage>
	let app: ReturnType<typeof createApp>

	beforeEach(async () => {
		resetRoundLimiterForTests()
		capture.mockClear()
		actorId = getTestActorId()
		workspaceId = (await insertWorkspace(db, actorId)).id
		mem = createMemoryStorage()
		app = createApp(mem.storage, actorId)
	})

	describe('submitting', () => {
		it('stores a proposal, changes with server-computed context, and leaves the file alone', async () => {
			const file = await insertFile(workspaceId, mem)
			const res = await submit(app, file.id, {
				summary: 'Tighten the plan',
				changes: [
					{ old_text: 'The budget is small.', new_text: 'The budget is tight.', reason: 'Tone' },
					{ old_text: 'We ship on Friday.', new_text: 'We ship on Thursday.' },
				],
			})
			expect(res.status).toBe(201)
			const body = (await res.json()) as {
				proposalId: string
				fileId: string
				url: string
				changeCount: number
			}
			expect(body.fileId).toBe(file.id)
			expect(body.changeCount).toBe(2)
			expect(body.url).toContain(`/${workspaceId}/files/${file.id}`)

			const changes = await db
				.select()
				.from(fileProposalChanges)
				.where(eq(fileProposalChanges.proposalId, body.proposalId))
				.orderBy(fileProposalChanges.ordinal)
			expect(changes.map((c) => c.ordinal)).toEqual([0, 1])
			expect(changes[0]).toMatchObject({
				oldText: 'The budget is small.',
				newText: 'The budget is tight.',
				reason: 'Tone',
				status: 'pending',
				contextAfter: '\n\nWe ship on Monday.\n',
			})
			expect(changes[0]?.contextBefore.length).toBeLessThanOrEqual(40)

			expect(mem.objects.get(file.storageKey)?.toString()).toBe(DOC)
		})

		it('records the session id and author', async () => {
			const sessionId = randomUUID()
			const file = await insertFile(workspaceId, mem)
			const res = await submit(createApp(mem.storage, actorId, { sessionId }), file.id, {
				changes: [{ old_text: 'small', new_text: 'tight' }],
			})
			expect(res.status).toBe(201)
			const [proposal] = await db
				.select()
				.from(fileProposals)
				.where(eq(fileProposals.fileId, file.id))
			expect(proposal).toMatchObject({ authorId: actorId, sessionId })
		})

		it('accepts notes.md stored as text/plain', async () => {
			const file = await insertFile(workspaceId, mem, { name: 'notes.md', mimeType: 'text/plain' })
			const res = await submit(app, file.id, {
				changes: [{ old_text: 'small', new_text: 'tight' }],
			})
			expect(res.status).toBe(201)
		})

		it('rejects a png and names the file type', async () => {
			const file = await insertFile(workspaceId, mem, { name: 'logo.png', mimeType: 'image/png' })
			const res = await submit(app, file.id, {
				changes: [{ old_text: 'small', new_text: 'tight' }],
			})
			expect(res.status).toBe(400)
			const body = (await res.json()) as { error: { message: string } }
			expect(body.error.message).toContain('image/png')
			expect(await proposalCount(file.id)).toBe(0)
			expect(capture).not.toHaveBeenCalled()
		})

		it('rejects the whole call when a change matches several times, naming its index', async () => {
			const file = await insertFile(workspaceId, mem)
			const res = await submit(app, file.id, {
				changes: [
					{ old_text: 'small', new_text: 'tight' },
					{ old_text: 'We ship on', new_text: 'We land on' },
				],
			})
			expect(res.status).toBe(400)
			const body = (await res.json()) as {
				error: { message: string; details: { field: string; message: string }[] }
			}
			expect(body.error.message).toContain('Change 1')
			expect(body.error.details[0]).toEqual({
				field: 'changes.1.old_text',
				message: 'old_text matches 2 times, include more surrounding text',
			})
			expect(await proposalCount(file.id)).toBe(0)
			expect(capture).not.toHaveBeenCalled()
		})

		it('rejects the whole call when a change matches nowhere', async () => {
			const file = await insertFile(workspaceId, mem)
			const res = await submit(app, file.id, {
				changes: [{ old_text: 'missing text', new_text: 'x' }],
			})
			expect(res.status).toBe(400)
			expect(await proposalCount(file.id)).toBe(0)
		})

		it('rejects overlapping changes', async () => {
			const file = await insertFile(workspaceId, mem)
			const res = await submit(app, file.id, {
				changes: [
					{ old_text: 'We ship on Friday.\n\nThe budget', new_text: 'a' },
					{ old_text: 'The budget is small.', new_text: 'b' },
				],
			})
			expect(res.status).toBe(400)
			const body = (await res.json()) as { error: { message: string } }
			expect(body.error.message).toContain('Change 1')
			expect(body.error.message).toContain('overlaps')
			expect(await proposalCount(file.id)).toBe(0)
		})

		it('enforces the limits: 50 changes, old_text 4000, new_text 8000', async () => {
			const file = await insertFile(workspaceId, mem)
			const tooMany = Array.from({ length: 51 }, () => ({ old_text: 'small', new_text: 'x' }))
			expect((await submit(app, file.id, { changes: tooMany })).status).toBe(400)
			expect(
				(
					await submit(app, file.id, {
						changes: [{ old_text: 'x'.repeat(4001), new_text: 'y' }],
					})
				).status,
			).toBe(400)
			expect(
				(
					await submit(app, file.id, {
						changes: [{ old_text: 'small', new_text: 'y'.repeat(8001) }],
					})
				).status,
			).toBe(400)
			expect(await proposalCount(file.id)).toBe(0)
		})

		it('accepts the maximum sizes', async () => {
			const longOld = 'o'.repeat(4000)
			const file = await insertFile(workspaceId, mem, { text: `${DOC}${longOld}\n` })
			const res = await submit(app, file.id, {
				changes: [{ old_text: longOld, new_text: 'n'.repeat(8000) }],
			})
			expect(res.status).toBe(201)
		})

		it('returns 404 for a file in a workspace the caller is not in', async () => {
			const other = await insertActor(db)
			const otherWs = (await insertWorkspace(db, other.id)).id
			const file = await insertFile(otherWs, mem)
			const res = await submit(app, file.id, {
				changes: [{ old_text: 'small', new_text: 'tight' }],
			})
			expect(res.status).toBe(404)
		})

		it('shares the send-round rate limiter', async () => {
			const file = await insertFile(workspaceId, mem)
			for (let i = 0; i < 10; i++) reserveRoundSlot(actorId)
			const res = await submit(app, file.id, {
				changes: [{ old_text: 'small', new_text: 'tight' }],
			})
			expect(res.status).toBe(429)
			expect(await proposalCount(file.id)).toBe(0)
			expect(capture).not.toHaveBeenCalled()
		})
	})

	describe('notification', () => {
		const rollups = (objectId: string) =>
			db
				.select()
				.from(events)
				.where(and(eq(events.entityId, objectId), eq(events.action, 'commented')))

		it('posts one rollup on each live attached object, mentioning its driver, and skips archived ones', async () => {
			const driverA = await insertActor(db, { type: 'agent' })
			const driverB = await insertActor(db, { type: 'agent' })
			const bet = await insertObject(db, workspaceId, actorId, { type: 'bet', driver: driverA.id })
			const task = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				driver: driverB.id,
			})
			const archived = await insertObject(db, workspaceId, actorId, { status: 'archived' })
			const file = await insertFile(workspaceId, mem)
			await attach(file.id, bet.id)
			await attach(file.id, task.id)
			await attach(file.id, archived.id)

			const res = await submit(app, file.id, {
				changes: [
					{ old_text: 'small', new_text: 'tight' },
					{ old_text: 'Friday', new_text: 'Thursday' },
				],
			})
			expect(res.status).toBe(201)
			const { proposalId } = (await res.json()) as { proposalId: string }

			const [betRollup] = await rollups(bet.id)
			expect(await rollups(bet.id)).toHaveLength(1)
			expect(await rollups(task.id)).toHaveLength(1)
			expect(await rollups(archived.id)).toHaveLength(0)

			const data = betRollup?.data as {
				mentions: string[]
				attention: number
				metadata: { file_proposal: { fileId: string; proposalId: string; count: number } }
			}
			expect(data.mentions).toEqual([driverA.id])
			expect(data.attention).toBe(3)
			expect(data.metadata.file_proposal).toEqual({ fileId: file.id, proposalId, count: 2 })
		})

		it('accepts a proposal on a file with no attaching object, with no notification', async () => {
			const file = await insertFile(workspaceId, mem)
			const res = await submit(app, file.id, {
				changes: [{ old_text: 'small', new_text: 'tight' }],
			})
			expect(res.status).toBe(201)
			expect(await proposalCount(file.id)).toBe(1)
			const rollups = await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, workspaceId), eq(events.action, 'commented')))
			expect(rollups).toHaveLength(0)
		})

		it('posts no rollup when the submit is rejected', async () => {
			const bet = await insertObject(db, workspaceId, actorId, { type: 'bet' })
			const file = await insertFile(workspaceId, mem)
			await attach(file.id, bet.id)
			await submit(app, file.id, { changes: [{ old_text: 'nope', new_text: 'x' }] })
			expect(await rollups(bet.id)).toHaveLength(0)
		})
	})

	describe('change_proposal_submitted event', () => {
		it('is sent once from the server after a successful submit', async () => {
			const file = await insertFile(workspaceId, mem)
			const res = await submit(app, file.id, {
				changes: [
					{ old_text: 'small', new_text: 'tight' },
					{ old_text: 'Friday', new_text: 'Thursday' },
				],
			})
			const { proposalId } = (await res.json()) as { proposalId: string }
			expect(capture).toHaveBeenCalledTimes(1)
			expect(capture).toHaveBeenCalledWith('change_proposal_submitted', actorId, {
				workspace_id: workspaceId,
				actor_id: actorId,
				file_name: 'plan.md',
				proposal_id: proposalId,
				change_count: 2,
			})
		})
	})

	describe('reading open proposals', () => {
		const list = (a: ReturnType<typeof createApp>, fileId: string) =>
			a.request(jsonGet(`/api/files/${fileId}/proposals?status=open`))

		it('returns proposals with author, changes and per-change staleness', async () => {
			const file = await insertFile(workspaceId, mem)
			await submit(app, file.id, {
				summary: 'Two edits',
				changes: [
					{ old_text: 'The budget is small.', new_text: 'The budget is tight.' },
					{ old_text: 'We ship on Friday.', new_text: 'We ship on Thursday.' },
				],
			})

			// Someone rewrites one of the two passages after the proposal.
			mem.objects.set(file.storageKey, Buffer.from(DOC.replace('Friday', 'Wednesday')))

			const res = await list(app, file.id)
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				proposals: {
					summary: string
					fileChangedSinceProposed: boolean
					author: { id: string }
					changes: { ordinal: number; stale: boolean; status: string }[]
				}[]
			}
			expect(body.proposals).toHaveLength(1)
			const [proposal] = body.proposals
			expect(proposal?.summary).toBe('Two edits')
			expect(proposal?.author.id).toBe(actorId)
			expect(proposal?.fileChangedSinceProposed).toBe(true)
			expect(proposal?.changes.map((c) => [c.ordinal, c.stale, c.status])).toEqual([
				[0, false, 'pending'],
				[1, true, 'pending'],
			])
		})

		it('does not report a file as changed when the bytes are the same', async () => {
			const file = await insertFile(workspaceId, mem)
			await submit(app, file.id, { changes: [{ old_text: 'small', new_text: 'tight' }] })
			const body = (await (await list(app, file.id)).json()) as {
				proposals: { fileChangedSinceProposed: boolean }[]
			}
			expect(body.proposals[0]?.fileChangedSinceProposed).toBe(false)
		})

		it('leaves out a proposal whose changes are all decided', async () => {
			const file = await insertFile(workspaceId, mem)
			const res = await submit(app, file.id, {
				changes: [{ old_text: 'small', new_text: 'tight' }],
			})
			const { proposalId } = (await res.json()) as { proposalId: string }
			await db
				.update(fileProposalChanges)
				.set({ status: 'rejected', decidedBy: actorId, decidedAt: new Date() })
				.where(eq(fileProposalChanges.proposalId, proposalId))
			const body = (await (await list(app, file.id)).json()) as { proposals: unknown[] }
			expect(body.proposals).toEqual([])
		})

		it('is readable by a plain member and hidden from a non-member', async () => {
			const file = await insertFile(workspaceId, mem)
			await submit(app, file.id, { changes: [{ old_text: 'small', new_text: 'tight' }] })

			const member = await insertActor(db)
			await db.insert(workspaceMembers).values({ workspaceId, actorId: member.id, role: 'member' })
			expect((await list(createApp(mem.storage, member.id), file.id)).status).toBe(200)

			const outsider = await insertActor(db)
			expect((await list(createApp(mem.storage, outsider.id), file.id)).status).toBe(404)
		})
	})
})
