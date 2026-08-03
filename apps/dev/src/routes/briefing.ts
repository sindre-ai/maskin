import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, files, objects, relationships } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, count, desc, eq, gt, ne, sql } from 'drizzle-orm'
import { errorSchema, objectResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import {
	BRIEFING_AUDIO_MIME_TYPE,
	BRIEFING_AUDIO_RELATIONSHIP_TYPE,
} from '../services/briefing-audio-renderer'

type Env = {
	Variables: {
		db: Database
		actorId: string
		storageProvider: StorageProvider
	}
}

const app = new OpenAPIHono<Env>()

// GET /api/briefing/latest — read surface for the featured briefing card.
//
// Returns the latest CoS-authored briefing (knowledge object with
// `metadata.kind = 'briefing'`) plus its attached audio file id and an
// `unreadDelta` count — everything the For You card needs in one round-trip.
//
// Cache is per-user because `unreadDelta` excludes events actored by the
// requester; we set `Cache-Control: private` and never populate a shared cache.
// SSE invalidation reuses the existing PgNotifyBridge fan-out on
// `object.created` (briefings are `knowledge` objects), so no new bridge is
// wired here — the client refreshes when the SSE stream reports a new
// briefing.
//
// Rollback: drop this route. The client falls back to an empty-state card
// (T4) rather than crashing.
const latestBriefingResponseSchema = z.object({
	object: objectResponseSchema.nullable(),
	audioFileId: z.string().uuid().nullable(),
	unreadDelta: z.number().int().nonnegative(),
})

const latestBriefingRoute = createRoute({
	method: 'get',
	path: '/latest',
	tags: ['Briefing'],
	summary: 'Latest briefing + attached audio id + unread delta since the previous briefing',
	description:
		'Returns the most recent briefing knowledge object for the workspace, the file id of its attached audio (or null if the audio pipeline has not rendered yet), and the count of events on workspace objects since the previous briefing that were not actored by the requesting user.',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Latest briefing payload',
			content: { 'application/json': { schema: latestBriefingResponseSchema } },
		},
		400: {
			description: 'Invalid workspace id',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(latestBriefingRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	// 1. Latest two briefings for this workspace. Two rows lets us derive the
	// "previous briefing" cutoff for the unread delta without a second query.
	const briefings = await db
		.select()
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'knowledge'),
				sql`${objects.metadata}->>'kind' = 'briefing'`,
			),
		)
		.orderBy(desc(objects.createdAt))
		.limit(2)

	const latest = briefings[0]
	const previous = briefings[1]

	if (!latest) {
		c.header('Cache-Control', 'private, max-age=30')
		c.header('Vary', 'X-Workspace-Id')
		return c.json({ object: null, audioFileId: null, unreadDelta: 0 }, 200)
	}

	// 2. Attached audio file id via T1's `attached` relationship row. MIME check
	// keeps this scoped to the audio artifact even if other file types get
	// attached to briefings later.
	const [audioRow] = await db
		.select({ fileId: files.id })
		.from(relationships)
		.innerJoin(files, eq(files.id, relationships.targetId))
		.where(
			and(
				eq(relationships.sourceType, 'object'),
				eq(relationships.sourceId, latest.id),
				eq(relationships.targetType, 'file'),
				eq(relationships.type, BRIEFING_AUDIO_RELATIONSHIP_TYPE),
				eq(files.mimeType, BRIEFING_AUDIO_MIME_TYPE),
			),
		)
		.limit(1)

	// 3. unreadDelta = workspace events on `object` entities that landed after
	// the previous briefing's createdAt, excluding events the requester
	// authored themselves. Per-user via the actor exclusion, so cache must stay
	// private. Falls back to 0 when there's no prior briefing to anchor to.
	let unreadDelta = 0
	if (previous?.createdAt) {
		const [row] = await db
			.select({ value: count() })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.entityType, 'object'),
					gt(events.createdAt, previous.createdAt),
					ne(events.actorId, actorId),
				),
			)
		unreadDelta = row?.value ?? 0
	}

	c.header('Cache-Control', 'private, max-age=30')
	c.header('Vary', 'X-Workspace-Id')
	return c.json(
		{
			object: serialize(latest) as z.infer<typeof objectResponseSchema>,
			audioFileId: audioRow?.fileId ?? null,
			unreadDelta,
		},
		200,
	)
}) as RouteHandler<typeof latestBriefingRoute, Env>)

export default app
