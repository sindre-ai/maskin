import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	actors,
	agentSkills,
	files,
	objects,
	relationships,
	trash,
	triggers,
	workspaceSkills,
} from '@maskin/db/schema'
import { and, count, desc, eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { TRASH_RETENTION_DAYS, type TrashKind, reviveDates } from '../lib/trash'
import { isWorkspaceWriter } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		/** Caller's role in the X-Workspace-Id workspace, set by authMiddleware. */
		workspaceRole?: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const TRASH_KIND_VALUES: [TrashKind, ...TrashKind[]] = [
	'object',
	'file',
	'trigger',
	'relationship',
	'workspace_skill',
]

const trashSummarySchema = z.object({
	id: z.string().uuid(),
	kind: z.enum(TRASH_KIND_VALUES),
	/** Human label: Flow, Item, File, Trigger, Link, Skill. */
	kindLabel: z.string(),
	entityId: z.string().uuid(),
	title: z.string(),
	subtitle: z.string().nullable(),
	deletedAt: z.string(),
	purgeAt: z.string(),
	deletedBy: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
})

type TrashSummary = z.infer<typeof trashSummarySchema>

function capitalize(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0) return ''
	return value.charAt(0).toUpperCase() + value.slice(1)
}

/** A short, human line for one trashed row, without exposing its full body. */
function summarize(row: {
	id: string
	kind: TrashKind
	entityId: string
	payload: Record<string, unknown>
	deletedAt: Date
	purgeAt: Date
	deletedById: string | null
	deletedByName: string | null
}): TrashSummary {
	const payload = row.payload
	let kindLabel = 'Item'
	let title = '(untitled)'
	let subtitle: string | null = null

	if (row.kind === 'object') {
		const type = typeof payload.type === 'string' ? payload.type : ''
		kindLabel = type === 'loop' ? 'Flow' : type ? capitalize(type) : 'Item'
		if (typeof payload.title === 'string' && payload.title.length > 0) title = payload.title
		const status = typeof payload.status === 'string' ? payload.status : null
		subtitle = status ? capitalize(status) : null
	} else if (row.kind === 'file') {
		kindLabel = 'File'
		if (typeof payload.name === 'string' && payload.name.length > 0) title = payload.name
		subtitle = typeof payload.mimeType === 'string' ? payload.mimeType : null
	} else if (row.kind === 'trigger') {
		kindLabel = 'Trigger'
		if (typeof payload.name === 'string' && payload.name.length > 0) title = payload.name
		subtitle = 'Trigger step'
	} else if (row.kind === 'relationship') {
		kindLabel = 'Link'
		title = typeof payload.type === 'string' ? payload.type.replace(/_/g, ' ') : 'Link'
		const source = typeof payload.sourceType === 'string' ? payload.sourceType : ''
		const target = typeof payload.targetType === 'string' ? payload.targetType : ''
		subtitle = source && target ? `${source} → ${target}` : null
	} else if (row.kind === 'workspace_skill') {
		kindLabel = 'Skill'
		if (typeof payload.name === 'string' && payload.name.length > 0) title = payload.name
		subtitle = 'Workspace skill'
	}

	return {
		id: row.id,
		kind: row.kind,
		kindLabel,
		entityId: row.entityId,
		title,
		subtitle,
		deletedAt: row.deletedAt.toISOString(),
		purgeAt: row.purgeAt.toISOString(),
		deletedBy:
			row.deletedById && row.deletedByName
				? { id: row.deletedById, name: row.deletedByName }
				: null,
	}
}

// GET / — List the trashed rows in the workspace, newest first.
const listTrashRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Trash'],
	summary: 'List deleted rows that can still be restored',
	request: {
		headers: workspaceIdHeader,
		query: z.object({
			kind: z.enum(TRASH_KIND_VALUES).optional(),
			limit: z.coerce.number().int().min(1).max(500).optional(),
			offset: z.coerce.number().int().min(0).optional(),
		}),
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						rows: z.array(trashSummarySchema),
						total: z.number(),
						trash_retention_days: z.number(),
					}),
				},
			},
			description: 'Trashed rows',
		},
	},
})

// POST /{id}/restore — Re-insert a trashed row.
const restoreTrashRoute = createRoute({
	method: 'post',
	path: '/{id}/restore',
	'x-viewer-policy': 'writer',
	tags: ['Trash'],
	summary: 'Restore a deleted row',
	request: { params: idParamSchema },
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						restored: z.boolean(),
						kind: z.enum(TRASH_KIND_VALUES),
						entityId: z.string().uuid(),
					}),
				},
			},
			description: 'Row restored',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Trash entry not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'A row with this id or name already exists',
		},
	},
})

app.openapi(listTrashRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { kind, limit, offset } = c.req.valid('query')

	const where = and(eq(trash.workspaceId, workspaceId), kind ? eq(trash.kind, kind) : undefined)

	const rows = await db
		.select({
			id: trash.id,
			kind: trash.kind,
			entityId: trash.entityId,
			payload: trash.row,
			deletedAt: trash.deletedAt,
			purgeAt: trash.purgeAt,
			deletedById: trash.deletedBy,
			deletedByName: actors.name,
		})
		.from(trash)
		.leftJoin(actors, eq(actors.id, trash.deletedBy))
		.where(where)
		.orderBy(desc(trash.deletedAt))
		.limit(limit ?? 200)
		.offset(offset ?? 0)

	const [totalRow] = await db.select({ total: count() }).from(trash).where(where)

	return c.json(
		{
			rows: rows.map((row) =>
				summarize({
					...row,
					kind: row.kind as TrashKind,
					payload: row.payload as Record<string, unknown>,
				}),
			),
			total: Number(totalRow?.total ?? 0),
			trash_retention_days: TRASH_RETENTION_DAYS,
		},
		200,
	)
}) as RouteHandler<typeof listTrashRoute, Env>)

app.openapi(restoreTrashRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [entry] = await db.select().from(trash).where(eq(trash.id, id)).limit(1)
	if (!entry || !(await isWorkspaceWriter(db, actorId, entry.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Trash entry not found'), 404)
	}

	const kind = entry.kind as TrashKind
	const row = entry.row as Record<string, unknown>
	const extra = (entry.extra ?? {}) as {
		loop_membership?: Array<Record<string, unknown>>
		agent_skills?: Array<Record<string, unknown>>
	}

	let restored = false
	await db.transaction(async (tx) => {
		if (kind === 'object') {
			const [inserted] = await tx
				.insert(objects)
				.values(reviveDates(kind, row) as unknown as typeof objects.$inferInsert)
				.onConflictDoNothing()
				.returning({ id: objects.id })
			if (!inserted) return
			// A flow's membership edges were removed by the delete; put them back.
			if (row.type === 'loop' && Array.isArray(extra.loop_membership)) {
				for (const edge of extra.loop_membership) {
					await tx
						.insert(relationships)
						.values(
							reviveDates('relationship', edge) as unknown as typeof relationships.$inferInsert,
						)
						.onConflictDoNothing()
				}
			}
			restored = true
		} else if (kind === 'file') {
			const [inserted] = await tx
				.insert(files)
				.values(reviveDates(kind, row) as unknown as typeof files.$inferInsert)
				.onConflictDoNothing()
				.returning({ id: files.id })
			restored = !!inserted
		} else if (kind === 'trigger') {
			const [inserted] = await tx
				.insert(triggers)
				.values(reviveDates(kind, row) as unknown as typeof triggers.$inferInsert)
				.onConflictDoNothing()
				.returning({ id: triggers.id })
			restored = !!inserted
		} else if (kind === 'relationship') {
			const [inserted] = await tx
				.insert(relationships)
				.values(reviveDates(kind, row) as unknown as typeof relationships.$inferInsert)
				.onConflictDoNothing()
				.returning({ id: relationships.id })
			restored = !!inserted
		} else if (kind === 'workspace_skill') {
			const [inserted] = await tx
				.insert(workspaceSkills)
				.values(reviveDates(kind, row) as unknown as typeof workspaceSkills.$inferInsert)
				.onConflictDoNothing()
				.returning({ id: workspaceSkills.id })
			if (!inserted) return
			// agent_skills rows cascade-deleted with the skill; attach them again.
			if (Array.isArray(extra.agent_skills)) {
				for (const attachment of extra.agent_skills) {
					await tx
						.insert(agentSkills)
						.values(attachment as unknown as typeof agentSkills.$inferInsert)
						.onConflictDoNothing()
				}
			}
			restored = true
		}

		if (!restored) return
		await tx.delete(trash).where(eq(trash.id, entry.id))
		await recordEvent(tx, {
			workspaceId: entry.workspaceId,
			actorId,
			action: 'restored',
			entityType: kind === 'object' ? String(row.type ?? 'object') : kind,
			entityId: entry.entityId,
			data: { kind, entityId: entry.entityId },
		})
	})

	if (!restored) {
		return c.json(
			createApiError(
				'CONFLICT',
				'Something with this id or name already exists, so it cannot be restored.',
			),
			409,
		)
	}

	return c.json({ restored: true as const, kind, entityId: entry.entityId }, 200)
}) as RouteHandler<typeof restoreTrashRoute, Env>)

export default app
