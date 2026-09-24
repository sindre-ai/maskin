import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, fileComments, files, relationships } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { resetRoundLimiterForTests } from '../../lib/file-comment-round-limiter'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: fileCommentsRoutes } = await import('../../routes/file-comments')

type Env = {
	Variables: {
		db: Database
		actorId: string
		notifyBridge: PgNotifyBridge
		sessionManager: unknown
	}
}

function createApp(actorId: string) {
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
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', { createSession: vi.fn() })
		await next()
	})
	app.route('/api/files', fileCommentsRoutes)
	return app
}

async function insertFile(
	workspaceId: string,
	actorId: string,
	overrides?: {
		name?: string
		annotations?: unknown[]
	},
) {
	const [file] = await db
		.insert(files)
		.values({
			workspaceId,
			name: overrides?.name ?? `deck-${randomUUID()}.html`,
			mimeType: 'text/html',
			sizeBytes: 100,
			storageKey: `test/${randomUUID()}`,
			createdBy: actorId,
			// biome-ignore lint/suspicious/noExplicitAny: test factory
			annotations: (overrides?.annotations ?? []) as any,
		})
		.returning()
	if (!file) throw new Error('file insert failed')
	return file
}

async function attachFileToObject(fileId: string, objectId: string, actorId: string) {
	await db.insert(relationships).values({
		sourceType: 'object',
		sourceId: objectId,
		targetType: 'file',
		targetId: fileId,
		type: 'attached',
		createdBy: actorId,
	})
}

async function createDraft(
	app: ReturnType<typeof createApp>,
	fileId: string,
	body: {
		body: string
		positionDoc?: { x: number; y: number }
		page?: number
		parentId?: string
	},
) {
	const res = await app.request(
		jsonRequest('POST', `/api/files/${fileId}/comments`, {
			body: body.body,
			positionDoc: body.positionDoc ?? { x: 0.25, y: 0.5 },
			page: body.page,
			parentId: body.parentId,
		}),
	)
	expect(res.status).toBe(201)
	return (await res.json()) as { id: string; roundId: string | null }
}

describe('File Comments Integration — CRUD basics', () => {
	let actorId: string
	let workspaceId: string
	let fileId: string

	beforeEach(async () => {
		resetRoundLimiterForTests()
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		const f = await insertFile(workspaceId, actorId)
		fileId = f.id
	})

	it('POST creates a draft with roundId=null and returns the persisted row', async () => {
		const app = createApp(actorId)
		const draft = await createDraft(app, fileId, { body: 'first thoughts' })
		expect(draft.roundId).toBeNull()

		const [row] = await db.select().from(fileComments).where(eq(fileComments.id, draft.id))
		expect(row?.body).toBe('first thoughts')
		expect(row?.fileId).toBe(fileId)
		expect(row?.authorId).toBe(actorId)
	})

	it('PATCH updates body, resolvedAt, and resolvedBy', async () => {
		const app = createApp(actorId)
		const draft = await createDraft(app, fileId, { body: 'v1' })

		const bodyRes = await app.request(
			jsonRequest('PATCH', `/api/files/${fileId}/comments/${draft.id}`, { body: 'v2' }),
		)
		expect(bodyRes.status).toBe(200)
		const bodyJson = (await bodyRes.json()) as { body: string; updatedAt: string }
		expect(bodyJson.body).toBe('v2')

		const resolveRes = await app.request(
			jsonRequest('PATCH', `/api/files/${fileId}/comments/${draft.id}`, { resolved: true }),
		)
		expect(resolveRes.status).toBe(200)
		const resolveJson = (await resolveRes.json()) as {
			resolvedAt: string | null
			resolvedBy: string | null
		}
		expect(resolveJson.resolvedAt).not.toBeNull()
		expect(resolveJson.resolvedBy).toBe(actorId)

		const reopen = await app.request(
			jsonRequest('PATCH', `/api/files/${fileId}/comments/${draft.id}`, { resolved: false }),
		)
		expect(reopen.status).toBe(200)
		const reopenJson = (await reopen.json()) as { resolvedAt: string | null }
		expect(reopenJson.resolvedAt).toBeNull()
	})
})

describe('File Comments Integration — round-send transactional write', () => {
	let actorId: string
	let workspaceId: string
	let fileId: string
	let targetObjectId: string

	beforeEach(async () => {
		resetRoundLimiterForTests()
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		const f = await insertFile(workspaceId, actorId, { name: 'v1.deck.html' })
		fileId = f.id
		const obj = await insertObject(db, workspaceId, actorId, { type: 'bet', driver: actorId })
		targetObjectId = obj.id
		await attachFileToObject(fileId, targetObjectId, actorId)
	})

	async function sendRound(
		app: ReturnType<typeof createApp>,
		payload: { roundId: string; targetObjectId: string; commentIds: string[] },
	) {
		return app.request(jsonRequest('POST', `/api/files/${fileId}/comments/rounds`, payload))
	}

	it('sets roundId on every listed row AND writes exactly ONE rollup event', async () => {
		const app = createApp(actorId)
		const drafts = await Promise.all([
			createDraft(app, fileId, { body: 'header cut off on mobile' }),
			createDraft(app, fileId, { body: 'CTA copy is too long' }),
			createDraft(app, fileId, { body: 'hero image is blurry' }),
		])

		const roundId = randomUUID()
		const res = await sendRound(app, {
			roundId,
			targetObjectId,
			commentIds: drafts.map((d) => d.id),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			roundId: string
			count: number
			rollupEventId: number
		}
		expect(body.roundId).toBe(roundId)
		expect(body.count).toBe(3)

		const rows = await db
			.select()
			.from(fileComments)
			.where(and(eq(fileComments.fileId, fileId), eq(fileComments.roundId, roundId)))
		expect(rows).toHaveLength(3)

		const rollupEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, targetObjectId), eq(events.action, 'commented')))
		expect(rollupEvents).toHaveLength(1)
		const rollup = rollupEvents[0]
		expect(rollup?.id).toBe(body.rollupEventId)
		// biome-ignore lint/suspicious/noExplicitAny: event data is jsonb
		const data = rollup?.data as any
		expect(data.content).toBe('3 new comments on v1.deck.html — open review round')
		expect(data.mentions).toEqual([actorId])
		expect(data.attention).toBe(4)
		expect(data.metadata.file_comments_round).toEqual({
			fileId,
			roundId,
			count: 3,
		})
	})

	it('uses attention=3 when the round carries fewer than three comments', async () => {
		const app = createApp(actorId)
		const draft = await createDraft(app, fileId, { body: 'single note' })
		const res = await sendRound(app, {
			roundId: randomUUID(),
			targetObjectId,
			commentIds: [draft.id],
		})
		expect(res.status).toBe(200)
		const [rollup] = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, targetObjectId), eq(events.action, 'commented')))
		// biome-ignore lint/suspicious/noExplicitAny: event data is jsonb
		expect((rollup?.data as any)?.attention).toBe(3)
	})

	it('retrying the same roundId is a no-op — no duplicate event, no second slot burnt', async () => {
		const app = createApp(actorId)
		const draft = await createDraft(app, fileId, { body: 'x' })
		const roundId = randomUUID()

		const first = await sendRound(app, { roundId, targetObjectId, commentIds: [draft.id] })
		expect(first.status).toBe(200)
		const firstBody = (await first.json()) as { rollupEventId: number }

		const second = await sendRound(app, { roundId, targetObjectId, commentIds: [draft.id] })
		expect(second.status).toBe(200)
		const secondBody = (await second.json()) as { rollupEventId: number }
		expect(secondBody.rollupEventId).toBe(firstBody.rollupEventId)

		const rollupEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, targetObjectId), eq(events.action, 'commented')))
		expect(rollupEvents).toHaveLength(1)
	})

	it('returns 429 after 10 successful rounds within 60s from the same actor', async () => {
		const app = createApp(actorId)
		// Ten distinct drafts + ten roundIds.
		const drafts = await Promise.all(
			Array.from({ length: 11 }, () => createDraft(app, fileId, { body: 'x' })),
		)
		let lastStatus = 0
		for (let i = 0; i < 10; i++) {
			const draft = drafts[i]
			if (!draft) throw new Error('expected draft')
			const res = await sendRound(app, {
				roundId: randomUUID(),
				targetObjectId,
				commentIds: [draft.id],
			})
			lastStatus = res.status
		}
		expect(lastStatus).toBe(200)
		const eleventhDraft = drafts[10]
		if (!eleventhDraft) throw new Error('expected 11th draft')
		const eleventh = await sendRound(app, {
			roundId: randomUUID(),
			targetObjectId,
			commentIds: [eleventhDraft.id],
		})
		expect(eleventh.status).toBe(429)
		const body = (await eleventh.json()) as { code: string }
		expect(body.code).toBe('RATE_LIMITED')
	})
})

describe('File Comments Integration — attaching-object validation matrix', () => {
	let actorId: string
	let workspaceId: string
	let fileId: string
	let draftId: string

	beforeEach(async () => {
		resetRoundLimiterForTests()
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		const f = await insertFile(workspaceId, actorId)
		fileId = f.id
		const app = createApp(actorId)
		const d = await createDraft(app, fileId, { body: 'note' })
		draftId = d.id
	})

	it('returns 400 NO_ATTACHER when the file has no attaching object', async () => {
		const app = createApp(actorId)
		const res = await app.request(
			jsonRequest('POST', `/api/files/${fileId}/comments/rounds`, {
				roundId: randomUUID(),
				targetObjectId: randomUUID(),
				commentIds: [draftId],
			}),
		)
		expect(res.status).toBe(400)
		const body = (await res.json()) as { code: string }
		expect(body.code).toBe('NO_ATTACHER')
	})

	it('returns 400 WRONG_TARGET when targetObjectId is not one of the attachers', async () => {
		const attacher = await insertObject(db, workspaceId, actorId, { type: 'bet' })
		await attachFileToObject(fileId, attacher.id, actorId)
		const app = createApp(actorId)
		const res = await app.request(
			jsonRequest('POST', `/api/files/${fileId}/comments/rounds`, {
				roundId: randomUUID(),
				targetObjectId: randomUUID(),
				commentIds: [draftId],
			}),
		)
		expect(res.status).toBe(400)
		expect(((await res.json()) as { code: string }).code).toBe('WRONG_TARGET')
	})

	it('accepts one attacher when targetObjectId matches it', async () => {
		const attacher = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			driver: actorId,
		})
		await attachFileToObject(fileId, attacher.id, actorId)
		const app = createApp(actorId)
		const res = await app.request(
			jsonRequest('POST', `/api/files/${fileId}/comments/rounds`, {
				roundId: randomUUID(),
				targetObjectId: attacher.id,
				commentIds: [draftId],
			}),
		)
		expect(res.status).toBe(200)
	})

	it('accepts any of multiple attachers as target', async () => {
		const a = await insertObject(db, workspaceId, actorId, { type: 'bet', driver: actorId })
		const b = await insertObject(db, workspaceId, actorId, { type: 'bet', driver: actorId })
		await attachFileToObject(fileId, a.id, actorId)
		await attachFileToObject(fileId, b.id, actorId)
		const app = createApp(actorId)
		const res = await app.request(
			jsonRequest('POST', `/api/files/${fileId}/comments/rounds`, {
				roundId: randomUUID(),
				targetObjectId: b.id,
				commentIds: [draftId],
			}),
		)
		expect(res.status).toBe(200)
	})

	it('treats only-archived attacher(s) as zero — NO_ATTACHER', async () => {
		const archived = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			status: 'archived',
		})
		await attachFileToObject(fileId, archived.id, actorId)
		const app = createApp(actorId)
		const res = await app.request(
			jsonRequest('POST', `/api/files/${fileId}/comments/rounds`, {
				roundId: randomUUID(),
				targetObjectId: archived.id,
				commentIds: [draftId],
			}),
		)
		expect(res.status).toBe(400)
		expect(((await res.json()) as { code: string }).code).toBe('NO_ATTACHER')
	})

	it('never allows a round to land on a target that is already archived at request time', async () => {
		// The full mid-flight race (target flips archived AFTER the outer
		// validation reads attachers but BEFORE the tx-inner FOR UPDATE) is
		// what the 409 TARGET_ARCHIVED branch protects against. That race
		// isn't reachable via HTTP without a driver-level hook. What we CAN
		// assert deterministically is the invariant that matters end-to-end:
		// an archived target is never written to, regardless of which branch
		// short-circuits (NO_ATTACHER, WRONG_TARGET, or TARGET_ARCHIVED).
		const attacher = await insertObject(db, workspaceId, actorId, {
			type: 'bet',
			driver: actorId,
			status: 'archived',
		})
		await attachFileToObject(fileId, attacher.id, actorId)
		const app = createApp(actorId)
		const res = await app.request(
			jsonRequest('POST', `/api/files/${fileId}/comments/rounds`, {
				roundId: randomUUID(),
				targetObjectId: attacher.id,
				commentIds: [draftId],
			}),
		)
		expect([400, 409]).toContain(res.status)
		expect(res.status).not.toBe(200)
	})
})

describe('File Comments Integration — legacy file.annotations migration', () => {
	let actorId: string
	let workspaceId: string
	let fileId: string

	beforeEach(async () => {
		resetRoundLimiterForTests()
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		const legacyPin = {
			id: 'pin-1',
			pinNumber: 1,
			selector: 'body > div:nth-child(2)',
			bounds: { x: 0.3, y: 0.4, w: 0.1, h: 0.05 },
			comment: 'legacy CTA feedback',
			position: { x: 0.32, y: 0.41 },
		}
		const f = await insertFile(workspaceId, actorId, { annotations: [legacyPin] })
		fileId = f.id
	})

	it('ports legacy pins on first read; a second read does not double-port', async () => {
		const app = createApp(actorId)

		const first = await app.request(jsonRequest('GET', `/api/files/${fileId}/comments`))
		expect(first.status).toBe(200)
		const firstRows = (await first.json()) as Array<{
			body: string
			selector: string | null
			positionDoc: { x: number; y: number }
		}>
		expect(firstRows).toHaveLength(1)
		const [ported] = firstRows
		expect(ported?.body).toBe('legacy CTA feedback')
		expect(ported?.selector).toBe('legacy')
		expect(ported?.positionDoc).toEqual({ x: 0.32, y: 0.41 })

		const second = await app.request(jsonRequest('GET', `/api/files/${fileId}/comments`))
		expect(second.status).toBe(200)
		const secondRows = (await second.json()) as unknown[]
		expect(secondRows).toHaveLength(1)

		const rowsInDb = await db.select().from(fileComments).where(eq(fileComments.fileId, fileId))
		expect(rowsInDb).toHaveLength(1)
	})
})

describe('File Comments Integration — no server-side cancel/undo path', () => {
	it('no cancel or undo endpoint exists on the file-comments surface', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const f = await insertFile(ws.id, actorId)
		const app = createApp(actorId)
		// Any request that names cancel/undo in the path must 404 — the
		// endpoint doesn't exist. Enforces the shape spec §No-gos (Sebk
		// 2026-09-07: send is final).
		const cancel = await app.request(
			jsonRequest('POST', `/api/files/${f.id}/comments/rounds/cancel`, { roundId: randomUUID() }),
		)
		expect(cancel.status).toBe(404)
		const undo = await app.request(
			jsonRequest('POST', `/api/files/${f.id}/comments/rounds/undo`, { roundId: randomUUID() }),
		)
		expect(undo.status).toBe(404)
	})
})
