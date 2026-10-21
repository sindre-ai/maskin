import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { validationFailureHook } from '../lib/errors'
import { loadVisibleForYou } from '../lib/for-you-visibility'
import { errorSchema, objectResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { feedDecisionSchema, fillDraftBodies, toLatestMention } from './subscriptions'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const forYouItemSchema = z.object({
	notification_id: z.string().uuid(),
	rank: z.number(),
	headline: z.string(),
	rationale: z.string().nullable(),
	created_at: z.string().nullable(),
	entity_type: z.literal('object').nullable(),
	entity_id: z.string().uuid().nullable(),
	session_id: z.string().uuid().nullable(),
	object: objectResponseSchema.optional(),
	latest_mention: z
		.object({
			event_id: z.number(),
			actor_id: z.string().uuid().nullable(),
			created_at: z.string(),
			content: z.string(),
			attention: z.number().nullable(),
			// With each draft's text and, for an email or message, its `preview`.
			decision: feedDecisionSchema.nullable(),
		})
		.optional(),
})

const forYouResponseSchema = z.object({ items: z.array(forYouItemSchema) })

const listForYouRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['For You'],
	summary: "The Chief of Staff's ranked list of what needs the current actor",
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Ranked For You items, already filtered against live state',
			content: { 'application/json': { schema: forYouResponseSchema } },
		},
		400: {
			description: 'Missing workspace ID',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listForYouRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const { cards, objectById, sourceById } = await loadVisibleForYou(db, workspaceId, actorId)

	const items = cards.map(({ row, meta }) => {
		const obj = row.objectId ? objectById.get(row.objectId) : undefined
		const source =
			meta.source_comment_id !== undefined ? sourceById.get(meta.source_comment_id) : undefined
		return {
			notification_id: row.id,
			rank: meta.rank,
			headline: meta.headline,
			rationale: meta.rationale ?? null,
			created_at: row.createdAt ? row.createdAt.toISOString() : null,
			entity_type: row.objectId ? ('object' as const) : null,
			entity_id: row.objectId ?? null,
			session_id: row.sessionId ?? null,
			...(obj ? { object: serialize(obj) as z.infer<typeof objectResponseSchema> } : {}),
			...(source ? { latest_mention: toLatestMention(source) } : {}),
		}
	})

	// A draft names an object: fill its text from the object as it reads now, and add its
	// preview (recipients, subject, approved or sent), the same as the unread feed does.
	// Without this a card carrying a draft shows no draft at all.
	await fillDraftBodies(
		db,
		workspaceId,
		items.flatMap((i) => (i.latest_mention ? [i.latest_mention] : [])),
		objectById,
	)

	return c.json({ items }, 200)
})

export default app
