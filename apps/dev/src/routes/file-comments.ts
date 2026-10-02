import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, fileComments, files, objects, relationships } from '@maskin/db/schema'
import {
	FILE_COMMENTS_ROUND_ERROR_CODES,
	createFileCommentSchema,
	fileCommentSchema,
	sendRoundResponseSchema,
	sendRoundSchema,
	updateFileCommentSchema,
} from '@maskin/shared'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { postComment } from '../lib/comments'
import { createApiError, validationFailureHook } from '../lib/errors'
import { reserveRoundSlot } from '../lib/file-comment-round-limiter'
import { migrateLegacyAnnotationsIfNeeded } from '../lib/file-comments-migration'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// -- Wire schemas -------------------------------------------------------------

const fileCommentParamSchema = z.object({
	id: z.string().uuid(),
})

const fileCommentIdParamsSchema = z.object({
	id: z.string().uuid(),
	cid: z.string().uuid(),
})

// Server-shape response — Drizzle returns Date instances; we serialize below.
function toDto(row: typeof fileComments.$inferSelect): z.infer<typeof fileCommentSchema> {
	return {
		id: row.id,
		fileId: row.fileId,
		page: row.page,
		positionDoc: row.positionDoc as { x: number; y: number },
		selector: row.selector,
		authorId: row.authorId,
		body: row.body,
		parentId: row.parentId,
		roundId: row.roundId,
		resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
		resolvedBy: row.resolvedBy,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	}
}

// Round-send error bodies. These are returned flat — not wrapped in the
// standard `error` envelope — with `code` (and `retryAfterMs` /
// `targetArchived` where relevant) at the top level. The web client's
// `request()` reads this shape and the send hook turns each `code` into a
// short message for the user. See tests for the full matrix.
function noAttacherBody() {
	return {
		code: FILE_COMMENTS_ROUND_ERROR_CODES.NO_ATTACHER,
		message: "This file isn't linked to anything yet.",
	}
}
function wrongTargetBody() {
	return {
		code: FILE_COMMENTS_ROUND_ERROR_CODES.WRONG_TARGET,
		message: "That item isn't linked to this file.",
	}
}
function targetArchivedBody() {
	return {
		code: FILE_COMMENTS_ROUND_ERROR_CODES.TARGET_ARCHIVED,
		message: 'That item was archived.',
		targetArchived: true as const,
	}
}
function rateLimitedBody(retryAfterMs: number) {
	const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
	return {
		code: FILE_COMMENTS_ROUND_ERROR_CODES.RATE_LIMITED,
		message: `Too many rounds sent. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
		retryAfterMs,
	}
}
function staleCommentsBody() {
	return {
		code: FILE_COMMENTS_ROUND_ERROR_CODES.STALE_COMMENTS,
		message: 'Some of these comments have changed.',
	}
}

// -- GET /:id/comments — read + one-shot legacy port -------------------------

const getFileCommentsRoute = createRoute({
	method: 'get',
	path: '/{id}/comments',
	tags: ['Files'],
	summary: 'List all comments on a file. Ports legacy annotations on first read.',
	request: {
		params: fileCommentParamSchema,
		query: z.object({
			roundId: z.string().uuid().optional(),
		}),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(fileCommentSchema) } },
			description: 'Comments on the file',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'File not found',
		},
	},
})

app.openapi(getFileCommentsRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id: fileId } = c.req.valid('param')
	const { roundId } = c.req.valid('query')

	const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1)
	if (!file || !(await isWorkspaceMember(db, actorId, file.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404 as never)
	}

	// One-shot legacy port. Idempotent — after the first read, subsequent
	// reads short-circuit inside the helper because a marker row with
	// `selector = 'legacy'` will exist for this file.
	try {
		await migrateLegacyAnnotationsIfNeeded(db, fileId, actorId)
	} catch (err) {
		// Read must not fail on migration hiccups — legacy pins are trace-level
		// per spec. Log and continue with whatever's already committed.
		logger.warn('Legacy annotation port failed; continuing with committed rows', {
			fileId,
			error: String(err),
		})
	}

	const conditions = [eq(fileComments.fileId, fileId)]
	if (roundId) conditions.push(eq(fileComments.roundId, roundId))
	const rows = await db
		.select()
		.from(fileComments)
		.where(and(...conditions))
		.orderBy(asc(fileComments.page), asc(fileComments.createdAt))

	return c.json(rows.map(toDto), 200)
}) as RouteHandler<typeof getFileCommentsRoute, Env>)

// -- POST /:id/comments — create draft ---------------------------------------

const createFileCommentRoute = createRoute({
	method: 'post',
	path: '/{id}/comments',
	tags: ['Files'],
	summary: 'Create a draft comment on a file (no roundId until sent).',
	request: {
		params: fileCommentParamSchema,
		body: { content: { 'application/json': { schema: createFileCommentSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: fileCommentSchema } },
			description: 'Draft comment created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'File not found',
		},
	},
})

app.openapi(createFileCommentRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id: fileId } = c.req.valid('param')
	const body = c.req.valid('json')

	const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1)
	if (!file || !(await isWorkspaceMember(db, actorId, file.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404 as never)
	}

	// If parentId is set, verify the parent lives on this same file — the
	// panel's threading UI can't render a reply anchored to a different file.
	if (body.parentId) {
		const [parent] = await db
			.select({ id: fileComments.id, fileId: fileComments.fileId })
			.from(fileComments)
			.where(eq(fileComments.id, body.parentId))
			.limit(1)
		if (!parent || parent.fileId !== fileId) {
			return c.json(
				createApiError('BAD_REQUEST', 'parentId does not reference a comment on this file'),
				400,
			)
		}
	}

	const [created] = await db
		.insert(fileComments)
		.values({
			fileId,
			page: body.page ?? null,
			positionDoc: body.positionDoc,
			selector: body.selector ?? null,
			authorId: actorId,
			body: body.body,
			parentId: body.parentId ?? null,
		})
		.returning()

	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create comment'), 500 as never)
	}

	return c.json(toDto(created), 201)
}) as RouteHandler<typeof createFileCommentRoute, Env>)

// -- PATCH /:id/comments/:cid — update body / resolve / reopen ---------------

const patchFileCommentRoute = createRoute({
	method: 'patch',
	path: '/{id}/comments/{cid}',
	tags: ['Files'],
	summary: 'Update a comment body, or resolve / reopen it.',
	request: {
		params: fileCommentIdParamsSchema,
		body: { content: { 'application/json': { schema: updateFileCommentSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: fileCommentSchema } },
			description: 'Comment updated',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: "Only the author can edit a comment's text",
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Comment not found',
		},
	},
})

app.openapi(patchFileCommentRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id: fileId, cid } = c.req.valid('param')
	const body = c.req.valid('json')

	const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1)
	if (!file || !(await isWorkspaceMember(db, actorId, file.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Comment not found'), 404 as never)
	}

	const [existing] = await db
		.select()
		.from(fileComments)
		.where(and(eq(fileComments.id, cid), eq(fileComments.fileId, fileId)))
		.limit(1)
	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Comment not found'), 404 as never)
	}

	// Anyone in the workspace can resolve or reopen a comment, but only the
	// author can change what it says.
	if (body.body !== undefined && existing.authorId !== actorId) {
		return c.json(
			createApiError('FORBIDDEN', 'Only the author can edit this comment'),
			403 as never,
		)
	}

	const patch: Partial<typeof fileComments.$inferInsert> = {}
	if (body.body !== undefined) patch.body = body.body
	if (body.resolved === true) {
		patch.resolvedAt = new Date()
		patch.resolvedBy = actorId
	} else if (body.resolved === false) {
		patch.resolvedAt = null
		patch.resolvedBy = null
	}

	const [updated] = await db
		.update(fileComments)
		.set(patch)
		.where(eq(fileComments.id, cid))
		.returning()

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Comment not found'), 404 as never)
	}

	return c.json(toDto(updated), 200)
}) as RouteHandler<typeof patchFileCommentRoute, Env>)

// -- POST /:id/comments/rounds — transactional round-send --------------------

const sendRoundRoute = createRoute({
	method: 'post',
	path: '/{id}/comments/rounds',
	tags: ['Files'],
	summary: 'Send a batched review round to the attaching object driver.',
	request: {
		params: fileCommentParamSchema,
		body: { content: { 'application/json': { schema: sendRoundSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: sendRoundResponseSchema } },
			description: 'Round sent (or idempotent replay).',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request or attaching-object mismatch',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'File not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Target archived between validate and write',
		},
		429: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Rate limit exceeded',
		},
	},
})

app.openapi(sendRoundRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id: fileId } = c.req.valid('param')
	const { roundId, targetObjectId, commentIds } = c.req.valid('json')

	const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1)
	if (!file || !(await isWorkspaceMember(db, actorId, file.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404 as never)
	}

	// The already-committed state of this round, or null if nothing has been
	// written under this roundId yet. The event is found by roundId alone, not
	// by the request's target, so a replay reports the event that was really
	// written even if the retry named a different target.
	const findCommittedRound = async () => {
		const committed = await db
			.select()
			.from(fileComments)
			.where(and(eq(fileComments.fileId, fileId), eq(fileComments.roundId, roundId)))
		if (committed.length === 0) return null
		const [rollupEvent] = await db
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, file.workspaceId),
					eq(events.action, 'commented'),
					sql`(${events.data}->'metadata'->'file_comments_round'->>'roundId') = ${roundId}`,
				),
			)
			.limit(1)
		return {
			roundId,
			count: committed.length,
			rollupEventId: rollupEvent?.id ?? 0,
			comments: committed.map(toDto),
		}
	}

	// -- Idempotency short-circuit (must precede rate-limit slot reservation).
	// A retried Send from a wobbly client (same roundId) should be a no-op —
	// return the already-committed state without burning a rate-limit slot or
	// re-writing the rollup event.
	const replay = await findCommittedRound()
	if (replay) return c.json(replay, 200)

	// -- Rate limit (10 rounds / 60s / actor).
	const slot = reserveRoundSlot(actorId)
	if (!slot.allowed) {
		return c.json(rateLimitedBody(slot.retryAfterMs) as never, 429)
	}

	// -- Attaching-object validation (spec §Attaching-object lookup rules).
	// Filter to non-archived server-side so an "only-archived attacher" file
	// behaves identically to a zero-attacher one — no round path forward.
	const attachers = await db
		.select({ id: objects.id, status: objects.status, driver: objects.driver })
		.from(relationships)
		.innerJoin(objects, eq(objects.id, relationships.sourceId))
		.where(
			and(
				eq(relationships.targetId, fileId),
				eq(relationships.type, 'attached'),
				eq(relationships.sourceType, 'object'),
			),
		)

	const liveAttachers = attachers.filter((a) => a.status !== 'archived')
	if (liveAttachers.length === 0) {
		return c.json(noAttacherBody() as never, 400)
	}
	if (!liveAttachers.some((a) => a.id === targetObjectId)) {
		return c.json(wrongTargetBody() as never, 400)
	}

	const target = liveAttachers.find((a) => a.id === targetObjectId)
	if (!target) {
		// Unreachable: the .some() check above already proved a match; the
		// biome noNonNullAssertion rule wants an explicit branch anyway.
		return c.json(wrongTargetBody() as never, 400)
	}

	// Comments must all belong to this file, be unsent (roundId IS NULL), and
	// exist. Anything else is a stale client — STALE_COMMENTS so the caller
	// re-reads the file's panel before retrying.
	const targetComments = await db
		.select()
		.from(fileComments)
		.where(
			and(
				eq(fileComments.fileId, fileId),
				inArray(fileComments.id, commentIds),
				isNull(fileComments.roundId),
			),
		)
	if (targetComments.length !== commentIds.length) {
		return c.json(staleCommentsBody() as never, 400)
	}

	// -- Transactional round write: mark comments + rollup event or nothing.
	const filename = file.name
	const attention = commentIds.length >= 3 ? 4 : 3
	const rollupContent = `${commentIds.length} new comments on ${filename} — open review round`

	try {
		const result = await db.transaction(async (tx) => {
			// Re-check target archival inside the tx with a row lock so a
			// concurrent archive between validate-above and write-here is
			// caught. Spec: return 409 TARGET_ARCHIVED so the client renders
			// the archived-strip UX.
			const [targetLocked] = await tx
				.select({ id: objects.id, status: objects.status, driver: objects.driver })
				.from(objects)
				.where(eq(objects.id, targetObjectId))
				.for('update')
				.limit(1)
			if (!targetLocked || targetLocked.status === 'archived') {
				throw new TargetArchivedError()
			}
			const driverId = targetLocked.driver ?? target.driver

			// Conditional update: only touch rows still unsent. The idempotency
			// short-circuit above catches a retry of an already-committed round,
			// but two Sends can both pass it before either commits. The loser's
			// UPDATE waits on the winner's row locks and then matches fewer
			// rows than were asked for.
			const updated = await tx
				.update(fileComments)
				.set({ roundId })
				.where(
					and(
						eq(fileComments.fileId, fileId),
						inArray(fileComments.id, commentIds),
						isNull(fileComments.roundId),
					),
				)
				.returning()

			// Someone else took some or all of these comments first. Abort so
			// nothing is written — no rollup event, no second mention of the
			// driver, and no half-sent round. The catch below decides whether
			// this was a duplicate of our own round or a genuine conflict.
			if (updated.length !== commentIds.length) {
				throw new RoundRaceError()
			}

			// ONE rollup event on the target object — see spec §Comment→timeline
			// write model, Option B. `postComment` handles the mentions +
			// subscription semantics inside the same tx (nested savepoint).
			// mentions is `[driverId]` when set; the driver may legitimately be
			// null on very fresh objects — in that case ship an empty mentions
			// array so the row still commits.
			const mentions = driverId ? [driverId] : []
			const { comment } = await postComment(tx, {
				workspaceId: file.workspaceId,
				actorId,
				entityId: targetObjectId,
				entityType: 'object',
				content: rollupContent,
				mentions,
				attention,
				metadata: {
					file_comments_round: {
						fileId,
						roundId,
						count: commentIds.length,
					},
				},
			})

			return { rollupEventId: comment.id, comments: updated }
		})

		return c.json(
			{
				roundId,
				count: commentIds.length,
				rollupEventId: result.rollupEventId,
				comments: result.comments.map(toDto),
			},
			200,
		)
	} catch (err) {
		if (err instanceof TargetArchivedError) {
			return c.json(targetArchivedBody() as never, 409)
		}
		if (err instanceof RoundRaceError) {
			// The transaction rolled back, so anything under this roundId was
			// written by the winning Send. Same round → report it as a replay.
			// Otherwise another round took the comments first.
			const winner = await findCommittedRound()
			if (winner) return c.json(winner, 200)
			return c.json(staleCommentsBody() as never, 400)
		}
		logger.error('file-comments round-send failed', {
			fileId,
			roundId,
			targetObjectId,
			error: String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Round send failed'), 500 as never)
	}
}) as RouteHandler<typeof sendRoundRoute, Env>)

class TargetArchivedError extends Error {
	constructor() {
		super('target archived mid-round')
		this.name = 'TargetArchivedError'
	}
}

class RoundRaceError extends Error {
	constructor() {
		super('comments were sent by another request')
		this.name = 'RoundRaceError'
	}
}

export default app
