import { OpenAPIHono, type RouteHandler, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	actors,
	fileProposalChanges,
	fileProposals,
	files,
	objects,
	relationships,
} from '@maskin/db/schema'
import {
	createFileProposalResponseSchema,
	createFileProposalSchema,
	isMarkdownFile,
	listFileProposalsQuerySchema,
	listFileProposalsResponseSchema,
} from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, asc, desc, eq, exists, inArray } from 'drizzle-orm'
import { trackChangeProposalSubmitted } from '../lib/analytics/file-proposal-events'
import { postComment } from '../lib/comments'
import { createApiError, validationFailureHook } from '../lib/errors'
import { reserveRoundSlot } from '../lib/file-comment-round-limiter'
import { isChangeStale, validateProposedChanges } from '../lib/file-proposals'
import { sha256Hex } from '../lib/file-save'
import { fileViewerUrl, frontendBaseUrl } from '../lib/file-urls'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema } from '../lib/openapi-schemas'
import { isWorkspaceMember, isWorkspaceWriter } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		storageProvider: StorageProvider
		/** Set by app-factory when the request carried a well-formed X-Maskin-Session-Id header. */
		maskinSessionId?: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// -- POST /:id/proposals — submit a proposal ----------------------------------

const createProposalRoute = createRoute({
	method: 'post',
	path: '/{id}/proposals',
	'x-viewer-policy': 'writer',
	tags: ['Files'],
	summary: 'Propose text changes to a markdown file instead of overwriting it.',
	request: {
		params: idParamSchema,
		body: { content: { 'application/json': { schema: createFileProposalSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: createFileProposalResponseSchema } },
			description: 'Proposal stored',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a markdown file, or a change does not match exactly once or overlaps',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'File not found',
		},
		429: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Rate limit exceeded',
		},
	},
})

app.openapi(createProposalRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const actorId = c.get('actorId')
	const { id: fileId } = c.req.valid('param')
	const body = c.req.valid('json')

	let frontendUrl: string
	try {
		frontendUrl = frontendBaseUrl()
	} catch (err) {
		logger.error('Cannot mint file URL', { error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'File URL not configured'), 500)
	}

	const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1)
	if (!file || !(await isWorkspaceWriter(db, actorId, file.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
	}

	if (!isMarkdownFile(file)) {
		return c.json(
			createApiError(
				'VALIDATION_ERROR',
				`Proposals only work on markdown files. ${file.name} is ${file.mimeType}.`,
			),
			400,
		)
	}

	let bytes: Buffer
	try {
		bytes = await storage.get(file.storageKey)
	} catch (err) {
		logger.error('Failed to read file bytes for proposal', {
			fileId,
			storageKey: file.storageKey,
			error: String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to read file bytes'), 500)
	}

	const checked = validateProposedChanges(bytes.toString('utf8'), body.changes)
	if (!checked.ok) {
		return c.json(
			createApiError(
				'VALIDATION_ERROR',
				`Change ${checked.index}: ${checked.message}. Nothing was stored.`,
				[{ field: `changes.${checked.index}.old_text`, message: checked.message }],
			),
			400,
		)
	}

	// Same limiter as send round, so one actor cannot flood a driver with
	// either kind of rollup. Taken after validation so a rejected submit does
	// not burn a slot.
	const slot = reserveRoundSlot(actorId)
	if (!slot.allowed) {
		const seconds = Math.max(1, Math.ceil(slot.retryAfterMs / 1000))
		return c.json(
			createApiError(
				'RATE_LIMITED',
				`Too many submissions. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
			),
			429,
		)
	}

	// Live objects the file is attached to (same lookup as send round). No
	// attacher is fine here: the proposal is stored and nobody is notified.
	const attachers = await db
		.select({ id: objects.id, status: objects.status, driver: objects.driver })
		.from(relationships)
		.innerJoin(objects, eq(objects.id, relationships.sourceId))
		.where(
			and(
				eq(relationships.targetId, fileId),
				eq(relationships.type, 'attached'),
				eq(relationships.sourceType, 'object'),
				eq(objects.workspaceId, file.workspaceId),
			),
		)
	const liveAttachers = attachers.filter((a) => a.status !== 'archived')

	const changeCount = body.changes.length
	const rollupContent = `${changeCount} proposed ${changeCount === 1 ? 'change' : 'changes'} to ${file.name}, ready for review`

	try {
		const proposalId = await db.transaction(async (tx) => {
			const [proposal] = await tx
				.insert(fileProposals)
				.values({
					fileId,
					workspaceId: file.workspaceId,
					authorId: actorId,
					sessionId: c.get('maskinSessionId') ?? null,
					summary: body.summary ?? null,
					baseSha256: sha256Hex(bytes),
				})
				.returning({ id: fileProposals.id })
			if (!proposal) throw new Error('proposal insert returned no row')

			await tx.insert(fileProposalChanges).values(
				body.changes.map((change, i) => {
					const match = checked.resolved[i]
					if (!match) throw new Error('validated change missing for index')
					return {
						proposalId: proposal.id,
						ordinal: i,
						oldText: change.old_text,
						newText: change.new_text,
						reason: change.reason ?? null,
						contextBefore: match.contextBefore,
						contextAfter: match.contextAfter,
					}
				}),
			)

			for (const attacher of liveAttachers) {
				await postComment(tx, {
					workspaceId: file.workspaceId,
					actorId,
					entityId: attacher.id,
					entityType: 'object',
					content: rollupContent,
					mentions: attacher.driver ? [attacher.driver] : [],
					attention: 3,
					metadata: { file_proposal: { fileId, proposalId: proposal.id, count: changeCount } },
				})
			}

			return proposal.id
		})

		void trackChangeProposalSubmitted({
			workspaceId: file.workspaceId,
			actorId,
			fileName: file.name,
			proposalId,
			changeCount,
		})

		return c.json(
			{
				proposalId,
				fileId,
				url: fileViewerUrl(frontendUrl, file.workspaceId, fileId),
				changeCount,
			},
			201,
		)
	} catch (err) {
		logger.error('File proposal submit failed', { fileId, error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to store the proposal'), 500)
	}
}) as RouteHandler<typeof createProposalRoute, Env>)

// -- GET /:id/proposals — open proposals with computed staleness --------------

const listProposalsRoute = createRoute({
	method: 'get',
	path: '/{id}/proposals',
	tags: ['Files'],
	summary: 'List the open change proposals on a file, with per-change staleness.',
	request: { params: idParamSchema, query: listFileProposalsQuerySchema },
	responses: {
		200: {
			content: { 'application/json': { schema: listFileProposalsResponseSchema } },
			description: 'Open proposals, newest first',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'File not found',
		},
	},
})

app.openapi(listProposalsRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const actorId = c.get('actorId')
	const { id: fileId } = c.req.valid('param')

	const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1)
	if (!file || !(await isWorkspaceMember(db, actorId, file.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'File not found'), 404)
	}

	// Open means at least one change is still pending.
	const proposals = await db
		.select({
			id: fileProposals.id,
			sessionId: fileProposals.sessionId,
			summary: fileProposals.summary,
			baseSha256: fileProposals.baseSha256,
			createdAt: fileProposals.createdAt,
			authorId: actors.id,
			authorName: actors.name,
			authorType: actors.type,
		})
		.from(fileProposals)
		.innerJoin(actors, eq(actors.id, fileProposals.authorId))
		.where(
			and(
				eq(fileProposals.fileId, fileId),
				exists(
					db
						.select({ one: fileProposalChanges.id })
						.from(fileProposalChanges)
						.where(
							and(
								eq(fileProposalChanges.proposalId, fileProposals.id),
								eq(fileProposalChanges.status, 'pending'),
							),
						),
				),
			),
		)
		.orderBy(desc(fileProposals.createdAt))

	if (proposals.length === 0) return c.json({ proposals: [] }, 200)

	let bytes: Buffer
	try {
		bytes = await storage.get(file.storageKey)
	} catch (err) {
		logger.error('Failed to read file bytes for proposals', {
			fileId,
			storageKey: file.storageKey,
			error: String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to read file bytes'), 500 as never)
	}
	const source = bytes.toString('utf8')
	const currentHash = sha256Hex(bytes)

	const changes = await db
		.select()
		.from(fileProposalChanges)
		.where(
			inArray(
				fileProposalChanges.proposalId,
				proposals.map((p) => p.id),
			),
		)
		.orderBy(asc(fileProposalChanges.ordinal))

	return c.json(
		{
			proposals: proposals.map((p) => ({
				id: p.id,
				fileId,
				author: { id: p.authorId, name: p.authorName, type: p.authorType },
				sessionId: p.sessionId,
				summary: p.summary,
				fileChangedSinceProposed: p.baseSha256 !== currentHash,
				createdAt: p.createdAt.toISOString(),
				changes: changes
					.filter((ch) => ch.proposalId === p.id)
					.map((ch) => ({
						id: ch.id,
						ordinal: ch.ordinal,
						oldText: ch.oldText,
						newText: ch.newText,
						reason: ch.reason,
						contextBefore: ch.contextBefore,
						contextAfter: ch.contextAfter,
						status: ch.status as 'pending' | 'accepted' | 'rejected',
						decidedBy: ch.decidedBy,
						decidedAt: ch.decidedAt ? ch.decidedAt.toISOString() : null,
						appliedText: ch.appliedText,
						// Only a pending change can be stale; a decided one is settled.
						stale: ch.status === 'pending' && isChangeStale(source, ch.oldText),
					})),
			})),
		},
		200,
	)
}) as RouteHandler<typeof listProposalsRoute, Env>)

export default app
