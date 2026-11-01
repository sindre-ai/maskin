import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
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
	acceptFileProposalChangeSchema,
	createFileProposalResponseSchema,
	createFileProposalSchema,
	decideFileProposalChangesResponseSchema,
	decideFileProposalChangesSchema,
	fileProposalChangeSchema,
	isMarkdownFile,
	listFileProposalsQuerySchema,
	listFileProposalsResponseSchema,
} from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, asc, desc, eq, exists, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { trackFileSaved } from '../lib/analytics/file-events'
import {
	trackChangeProposalSubmitted,
	trackChangeReviewed,
} from '../lib/analytics/file-proposal-events'
import { postComment } from '../lib/comments'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { reserveRoundSlot } from '../lib/file-comment-round-limiter'
import {
	ChangesAlreadyDecidedError,
	ChangesStaleError,
	type ProposalChangeRow,
	acceptProposalChanges,
	rejectProposalChanges,
} from '../lib/file-proposal-decisions'
import { toChangeDto, validateProposedChanges } from '../lib/file-proposals'
import { FileSaveTimeoutError, sha256Hex } from '../lib/file-save'
import { fileViewerUrl, frontendBaseUrl } from '../lib/file-urls'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema } from '../lib/openapi-schemas'
import {
	getWorkspaceRole,
	isWorkspaceHumanNonViewer,
	isWorkspaceMember,
	isWorkspaceWriter,
} from '../lib/workspace-auth'

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
					.map((ch) => toChangeDto(ch, source)),
			})),
		},
		200,
	)
}) as RouteHandler<typeof listProposalsRoute, Env>)

// -- Deciding changes: accept and reject --------------------------------------

const proposalChangeParamSchema = z.object({
	id: z.string().uuid(),
	pid: z.string().uuid(),
	cid: z.string().uuid(),
})
const proposalParamSchema = z.object({ id: z.string().uuid(), pid: z.string().uuid() })

// 409 body: the standard error envelope plus the changes that could not be
// applied, so a client can mark them without asking again. Empty when the
// conflict is that a change was already decided.
const changeConflictSchema = errorSchema.extend({ staleChangeIds: z.array(z.string().uuid()) })

const decisionResponses = {
	403: {
		content: { 'application/json': { schema: errorSchema } },
		description: 'Not a person who can decide: a viewer, an agent, or the author of the proposal',
	},
	404: {
		content: { 'application/json': { schema: errorSchema } },
		description: 'File, proposal or change not found',
	},
	409: {
		content: { 'application/json': { schema: changeConflictSchema } },
		description:
			'A change is stale (it no longer matches the file exactly once) or was already decided; nothing was changed',
	},
	503: {
		content: { 'application/json': { schema: errorSchema } },
		description: 'Timed out waiting for the file or storage; nothing was written, retry is safe',
	},
}

type DecisionTarget =
	| { ok: true; file: typeof files.$inferSelect; proposal: typeof fileProposals.$inferSelect }
	| { ok: false; status: 403 | 404; message: string }

/**
 * Who may decide, and on what. A non-member sees the same 404 as a missing file.
 * Only a human member who is not a viewer may decide, and never on a proposal
 * they wrote themselves.
 */
async function resolveDecisionTarget(
	db: Database,
	actorId: string,
	fileId: string,
	proposalId: string,
): Promise<DecisionTarget> {
	const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1)
	if (!file || (await getWorkspaceRole(db, actorId, file.workspaceId)) === null) {
		return { ok: false, status: 404, message: 'File not found' }
	}
	if (!(await isWorkspaceHumanNonViewer(db, actorId, file.workspaceId))) {
		return {
			ok: false,
			status: 403,
			message: 'Only people who can edit this workspace can accept or reject changes',
		}
	}
	const [proposal] = await db
		.select()
		.from(fileProposals)
		.where(and(eq(fileProposals.id, proposalId), eq(fileProposals.fileId, fileId)))
		.limit(1)
	if (!proposal) return { ok: false, status: 404, message: 'Proposal not found' }
	if (proposal.authorId === actorId) {
		return {
			ok: false,
			status: 403,
			message: 'You cannot accept or reject a proposal you made yourself',
		}
	}
	return { ok: true, file, proposal }
}

/** Every id must be a change of this proposal and still pending; otherwise the status and ids to answer with. */
async function checkPendingChanges(db: Database, proposalId: string, changeIds: string[]) {
	const rows = await db
		.select({ id: fileProposalChanges.id, status: fileProposalChanges.status })
		.from(fileProposalChanges)
		.where(
			and(
				eq(fileProposalChanges.proposalId, proposalId),
				inArray(fileProposalChanges.id, changeIds),
			),
		)
	if (rows.length !== changeIds.length) return { ok: false as const, status: 404 as const }
	if (rows.some((r) => r.status !== 'pending')) return { ok: false as const, status: 409 as const }
	return { ok: true as const }
}

const alreadyDecidedMessage = 'This change was already accepted or rejected'

function reviewDecision(change: ProposalChangeRow): 'accepted' | 'edited_then_accepted' {
	return change.appliedText !== null && change.appliedText !== change.newText
		? 'edited_then_accepted'
		: 'accepted'
}

/** Accept: the whole thing is one save, so a stale change or a failure leaves the file as it was. */
async function acceptChanges(
	c: Context<Env>,
	params: { fileId: string; proposalId: string },
	items: { changeId: string; appliedText?: string }[],
	opts: { reportStale?: boolean } = {},
) {
	const db = c.get('db')
	const actorId = c.get('actorId')

	const target = await resolveDecisionTarget(db, actorId, params.fileId, params.proposalId)
	if (!target.ok)
		return {
			status: target.status,
			body: createApiError(target.status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', target.message),
		}
	const { file, proposal } = target

	const checked = await checkPendingChanges(
		db,
		proposal.id,
		items.map((i) => i.changeId),
	)
	if (!checked.ok) {
		return checked.status === 404
			? { status: 404 as const, body: createApiError('NOT_FOUND', 'Change not found') }
			: {
					status: 409 as const,
					body: { ...createApiError('CONFLICT', alreadyDecidedMessage), staleChangeIds: [] },
				}
	}

	let result: Awaited<ReturnType<typeof acceptProposalChanges>>
	try {
		result = await acceptProposalChanges(
			{ db, storage: c.get('storageProvider') },
			{ fileId: file.id, proposalId: proposal.id, deciderId: actorId, items },
		)
	} catch (err) {
		if (err instanceof ChangesStaleError) {
			// Nothing was applied. A bulk accept reports each stale change; the pending ones
			// were not decided and send nothing.
			if (opts.reportStale) {
				for (const changeId of err.changeIds) {
					void trackChangeReviewed({
						workspaceId: file.workspaceId,
						actorId,
						fileName: file.name,
						proposalId: proposal.id,
						changeId,
						decision: 'stale',
					})
				}
			}
			return {
				status: 409 as const,
				body: {
					...createApiError(
						'CONFLICT',
						`${err.changeIds.length === 1 ? 'A change no longer matches' : 'Some changes no longer match'} the file. Nothing was applied.`,
						undefined,
						'A stale change can only be rejected.',
					),
					staleChangeIds: err.changeIds,
				},
			}
		}
		if (err instanceof ChangesAlreadyDecidedError) {
			return {
				status: 409 as const,
				body: { ...createApiError('CONFLICT', alreadyDecidedMessage), staleChangeIds: [] },
			}
		}
		if (err instanceof FileSaveTimeoutError) {
			logger.warn('Accepting changes timed out; rolled back', { fileId: file.id, stage: err.stage })
			c.header('Retry-After', '1')
			return {
				status: 503 as const,
				body: createApiError('INTERNAL_ERROR', err.message, undefined, 'Retry the accept.'),
			}
		}
		logger.error('Accepting proposed changes failed', {
			fileId: file.id,
			proposalId: proposal.id,
			error: String(err),
		})
		return {
			status: 500 as const,
			body: createApiError('INTERNAL_ERROR', 'Failed to apply the changes'),
		}
	}
	if (!result) return { status: 404 as const, body: createApiError('NOT_FOUND', 'File not found') }

	// Committed. Everything below is best effort and never undoes the decision.
	const { changes, contentChanged } = result
	for (const change of changes) {
		void trackChangeReviewed({
			workspaceId: file.workspaceId,
			actorId,
			fileName: file.name,
			proposalId: proposal.id,
			changeId: change.id,
			decision: reviewDecision(change),
		})
	}
	if (contentChanged) {
		// Re-read the row for the size the save wrote.
		const [saved] = await db.select().from(files).where(eq(files.id, file.id)).limit(1)
		void trackFileSaved({
			workspaceId: file.workspaceId,
			fileId: file.id,
			actorId,
			actorType: 'human',
			fileType: file.mimeType,
			sizeBytes: saved?.sizeBytes ?? file.sizeBytes,
			acceptedChange: {
				proposalId: proposal.id,
				proposalSessionId: proposal.sessionId,
				acceptedCount: changes.length,
				editedCount: changes.filter((ch) => reviewDecision(ch) === 'edited_then_accepted').length,
			},
		})
		try {
			await recordEvent(db, {
				workspaceId: file.workspaceId,
				actorId,
				action: 'updated',
				entityType: 'file',
				entityId: file.id,
				data: {
					id: file.id,
					name: file.name,
					mimeType: file.mimeType,
					sizeBytes: saved?.sizeBytes ?? file.sizeBytes,
				},
				provenance: { sessionId: c.get('maskinSessionId'), entityKind: 'file' },
			})
		} catch (err) {
			logger.error('Failed to record file updated audit event', {
				workspaceId: file.workspaceId,
				fileId: file.id,
				error: String(err),
			})
		}
	}
	return { status: 200 as const, changes }
}

async function rejectChanges(
	c: Context<Env>,
	params: { fileId: string; proposalId: string },
	changeIds: string[],
) {
	const db = c.get('db')
	const actorId = c.get('actorId')

	const target = await resolveDecisionTarget(db, actorId, params.fileId, params.proposalId)
	if (!target.ok)
		return {
			status: target.status,
			body: createApiError(target.status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', target.message),
		}
	const { file, proposal } = target

	const checked = await checkPendingChanges(db, proposal.id, changeIds)
	if (!checked.ok) {
		return checked.status === 404
			? { status: 404 as const, body: createApiError('NOT_FOUND', 'Change not found') }
			: {
					status: 409 as const,
					body: { ...createApiError('CONFLICT', alreadyDecidedMessage), staleChangeIds: [] },
				}
	}

	let changes: ProposalChangeRow[]
	try {
		changes = await rejectProposalChanges(db, {
			proposalId: proposal.id,
			deciderId: actorId,
			changeIds,
		})
	} catch (err) {
		if (err instanceof ChangesAlreadyDecidedError) {
			return {
				status: 409 as const,
				body: { ...createApiError('CONFLICT', alreadyDecidedMessage), staleChangeIds: [] },
			}
		}
		logger.error('Rejecting proposed changes failed', {
			fileId: file.id,
			proposalId: proposal.id,
			error: String(err),
		})
		return {
			status: 500 as const,
			body: createApiError('INTERNAL_ERROR', 'Failed to reject the changes'),
		}
	}

	for (const change of changes) {
		void trackChangeReviewed({
			workspaceId: file.workspaceId,
			actorId,
			fileName: file.name,
			proposalId: proposal.id,
			changeId: change.id,
			decision: 'rejected',
		})
	}
	return { status: 200 as const, changes }
}

const acceptChangeRoute = createRoute({
	method: 'post',
	path: '/{id}/proposals/{pid}/changes/{cid}/accept',
	'x-viewer-policy': 'writer',
	tags: ['Files'],
	summary: 'Accept one proposed change, optionally with edited text, and write it to the file.',
	request: {
		params: proposalChangeParamSchema,
		body: {
			required: false,
			content: { 'application/json': { schema: acceptFileProposalChangeSchema } },
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: fileProposalChangeSchema } },
			description: 'The change, now accepted',
		},
		...decisionResponses,
	},
})

app.openapi(acceptChangeRoute, (async (c) => {
	const { id, pid, cid } = c.req.valid('param')
	const body = c.req.valid('json')
	const result = await acceptChanges(c, { fileId: id, proposalId: pid }, [
		{ changeId: cid, appliedText: body?.applied_text },
	])
	if (result.status !== 200) return c.json(result.body, result.status)
	const [change] = result.changes
	return c.json(toChangeDto(change as ProposalChangeRow, null), 200)
}) as RouteHandler<typeof acceptChangeRoute, Env>)

const rejectChangeRoute = createRoute({
	method: 'post',
	path: '/{id}/proposals/{pid}/changes/{cid}/reject',
	'x-viewer-policy': 'writer',
	tags: ['Files'],
	summary: 'Reject one proposed change. The file is not touched.',
	request: { params: proposalChangeParamSchema },
	responses: {
		200: {
			content: { 'application/json': { schema: fileProposalChangeSchema } },
			description: 'The change, now rejected',
		},
		...decisionResponses,
	},
})

app.openapi(rejectChangeRoute, (async (c) => {
	const { id, pid, cid } = c.req.valid('param')
	const result = await rejectChanges(c, { fileId: id, proposalId: pid }, [cid])
	if (result.status !== 200) return c.json(result.body, result.status)
	const [change] = result.changes
	return c.json(toChangeDto(change as ProposalChangeRow, null), 200)
}) as RouteHandler<typeof rejectChangeRoute, Env>)

const bulkAcceptRoute = createRoute({
	method: 'post',
	path: '/{id}/proposals/{pid}/changes/accept',
	'x-viewer-policy': 'writer',
	tags: ['Files'],
	summary:
		'Accept several changes of one proposal, all or nothing. If any is stale none is applied.',
	request: {
		params: proposalParamSchema,
		body: { content: { 'application/json': { schema: decideFileProposalChangesSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: decideFileProposalChangesResponseSchema } },
			description: 'The changes, now accepted',
		},
		...decisionResponses,
	},
})

app.openapi(bulkAcceptRoute, (async (c) => {
	const { id, pid } = c.req.valid('param')
	const { change_ids } = c.req.valid('json')
	const items = [...new Set(change_ids)].map((changeId) => ({ changeId }))
	const result = await acceptChanges(c, { fileId: id, proposalId: pid }, items, {
		reportStale: true,
	})
	if (result.status !== 200) return c.json(result.body, result.status)
	return c.json({ changes: result.changes.map((ch) => toChangeDto(ch, null)) }, 200)
}) as RouteHandler<typeof bulkAcceptRoute, Env>)

const bulkRejectRoute = createRoute({
	method: 'post',
	path: '/{id}/proposals/{pid}/changes/reject',
	'x-viewer-policy': 'writer',
	tags: ['Files'],
	summary: 'Reject several changes of one proposal, all or nothing. The file is not touched.',
	request: {
		params: proposalParamSchema,
		body: { content: { 'application/json': { schema: decideFileProposalChangesSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: decideFileProposalChangesResponseSchema } },
			description: 'The changes, now rejected',
		},
		...decisionResponses,
	},
})

app.openapi(bulkRejectRoute, (async (c) => {
	const { id, pid } = c.req.valid('param')
	const { change_ids } = c.req.valid('json')
	const result = await rejectChanges(c, { fileId: id, proposalId: pid }, [...new Set(change_ids)])
	if (result.status !== 200) return c.json(result.body, result.status)
	return c.json({ changes: result.changes.map((ch) => toChangeDto(ch, null)) }, 200)
}) as RouteHandler<typeof bulkRejectRoute, Env>)

export default app
