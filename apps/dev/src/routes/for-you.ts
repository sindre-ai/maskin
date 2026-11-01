import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, forYouDismissals, notifications } from '@maskin/db/schema'
import { FOR_YOU_KIND } from '@maskin/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { buildForYouItems, forYouItemSchema } from '../lib/for-you-items'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const forYouResponseSchema = z.object({ items: z.array(forYouItemSchema) })

const listForYouRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['For You'],
	summary:
		"What needs the current actor: the Chief of Staff's ranked list, then decision cards addressed to them",
	request: {
		headers: workspaceIdHeader,
		query: z.object({
			for_actor_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					"Read another member's list. Agents may ask for any member; a person may only ask for their own.",
				),
		}),
	},
	responses: {
		200: {
			description: 'Ranked For You items, already filtered against live state',
			content: { 'application/json': { schema: forYouResponseSchema } },
		},
		400: {
			description: 'Missing workspace ID',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: "A person asked for someone else's list",
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'for_actor_id is not a member of the workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listForYouRoute, async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { for_actor_id: forActorId } = c.req.valid('query')

	let actorId = callerId
	if (forActorId && forActorId !== callerId) {
		if (c.get('actorType') !== 'agent') {
			return c.json(createApiError('FORBIDDEN', 'You can only read your own For You list'), 403)
		}
		if (!(await isWorkspaceMember(db, forActorId, workspaceId))) {
			return c.json(createApiError('NOT_FOUND', 'Actor not found in this workspace'), 404)
		}
		actorId = forActorId
	}

	return c.json({ items: await buildForYouItems(db, workspaceId, actorId) }, 200)
})

const dismissBodySchema = z
	.object({
		notification_id: z
			.string()
			.uuid()
			.optional()
			.describe("A curated card's notification_id from the list."),
		source_comment_id: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("A decision card's latest_mention.event_id from the list."),
	})
	.refine((b) => b.notification_id !== undefined || b.source_comment_id !== undefined, {
		message: 'Give a notification_id or a source_comment_id',
	})

type DismissBody = z.infer<typeof dismissBodySchema>

const dismissResponses = {
	200: {
		description: 'Done',
		content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
	},
	400: {
		description: 'Missing workspace ID, or neither id given',
		content: { 'application/json': { schema: errorSchema } },
	},
	404: {
		description: 'No such card for this person in this workspace',
		content: { 'application/json': { schema: errorSchema } },
	},
}

const dismissRoute = createRoute({
	method: 'post',
	path: '/dismissals',
	tags: ['For You'],
	summary:
		'Dismiss a For You card. Separate from reading: opening the page does not dismiss a card, this does.',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: dismissBodySchema } } },
	},
	responses: dismissResponses,
})

const undismissRoute = createRoute({
	method: 'post',
	path: '/dismissals/undo',
	tags: ['For You'],
	summary: 'Undo a Dismiss, so the card comes back',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: dismissBodySchema } } },
	},
	responses: dismissResponses,
})

/** The caller's own For You notification, or undefined when it is not theirs or not a For You card. */
async function findOwnCard(db: Database, workspaceId: string, actorId: string, id: string) {
	const [row] = await db
		.select({ id: notifications.id, status: notifications.status })
		.from(notifications)
		.where(
			and(
				eq(notifications.id, id),
				eq(notifications.workspaceId, workspaceId),
				eq(notifications.targetActorId, actorId),
				eq(notifications.type, 'needs_input'),
				sql`${notifications.metadata}->>'kind' = ${FOR_YOU_KIND}`,
			),
		)
		.limit(1)
	return row
}

async function commentExists(db: Database, workspaceId: string, id: number) {
	const [row] = await db
		.select({ id: events.id })
		.from(events)
		.where(
			and(
				eq(events.id, id),
				eq(events.workspaceId, workspaceId),
				eq(events.action, 'commented'),
				eq(events.entityType, 'object'),
			),
		)
		.limit(1)
	return !!row
}

/**
 * Applies a dismiss or an undo to what the body names. A curated card carries its own status;
 * a decision card has only its source comment, so it gets a row in for_you_dismissals. Checks
 * every id before changing anything, so a bad id never leaves the other half done.
 */
async function setDismissed(
	db: Database,
	workspaceId: string,
	actorId: string,
	body: DismissBody,
	dismissed: boolean,
): Promise<boolean> {
	const card = body.notification_id
		? await findOwnCard(db, workspaceId, actorId, body.notification_id)
		: undefined
	if (body.notification_id && !card) return false
	if (body.source_comment_id !== undefined) {
		if (!(await commentExists(db, workspaceId, body.source_comment_id))) return false
	}

	if (card) {
		// Undo only reverses a dismissal; a card someone resolved stays resolved.
		await db
			.update(notifications)
			.set({ status: dismissed ? 'dismissed' : 'pending', updatedAt: new Date() })
			.where(
				and(
					eq(notifications.id, card.id),
					inArray(notifications.status, dismissed ? ['pending', 'seen'] : ['dismissed']),
				),
			)
	}
	if (body.source_comment_id !== undefined) {
		if (dismissed) {
			await db
				.insert(forYouDismissals)
				.values({ workspaceId, actorId, sourceCommentId: body.source_comment_id })
				.onConflictDoNothing()
		} else {
			await db
				.delete(forYouDismissals)
				.where(
					and(
						eq(forYouDismissals.actorId, actorId),
						eq(forYouDismissals.sourceCommentId, body.source_comment_id),
					),
				)
		}
	}
	return true
}

app.openapi(dismissRoute, async (c) => {
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const ok = await setDismissed(
		c.get('db'),
		workspaceId,
		c.get('actorId'),
		c.req.valid('json'),
		true,
	)
	if (!ok) return c.json(createApiError('NOT_FOUND', 'Card not found'), 404)
	return c.json({ ok: true as const }, 200)
})

app.openapi(undismissRoute, async (c) => {
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const ok = await setDismissed(
		c.get('db'),
		workspaceId,
		c.get('actorId'),
		c.req.valid('json'),
		false,
	)
	if (!ok) return c.json(createApiError('NOT_FOUND', 'Card not found'), 404)
	return c.json({ ok: true as const }, 200)
})

export default app
