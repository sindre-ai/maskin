import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, objects } from '@maskin/db/schema'
import { objectPreviewSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordObjectApproval, withDeliveryState } from '../lib/object-delivery'
import { buildObjectPreview } from '../lib/object-preview'
import { errorSchema } from '../lib/openapi-schemas'
import { isWorkspaceWriter } from '../lib/workspace-auth'
import { approvedInstruction, wakeAgentFromCard } from '../services/chat-card-wake'
import type { SessionManager } from '../services/session-manager'

/**
 * A person's yes to sending a drafted object (an email, a LinkedIn message) exactly as it
 * reads now. Provider-agnostic: any kind an integration declares in `deliverables` is
 * approved here, and the integration's own send tool checks the approval before it sends.
 *
 * Only a person can approve. An agent that calls this is refused, so an approval in the
 * log always means a human saw this text. The approval is bound to the preview's
 * `content_hash`; editing the draft changes the hash, which withdraws the approval.
 *
 * Approved from a card in a chat, the request names that chat and the agent behind the card,
 * and the agent is told to send it there. No message is posted in the person's name.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		sessionManager: SessionManager
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const approveRoute = createRoute({
	method: 'post',
	path: '/{id}/approval',
	'x-viewer-policy': 'writer',
	tags: ['Objects'],
	summary: 'Approve a drafted object for sending',
	description:
		'Records that the calling person approved the draft exactly as it reads now. Humans only. Pass the preview’s content_hash so a draft that changed since it was shown is refused.',
	request: {
		params: z.object({ id: z.string().uuid() }),
		body: {
			content: {
				'application/json': {
					schema: z.object({
						content_hash: z.string().min(1).max(100).optional(),
						/** The chat card this was approved from: the agent behind it is told to send. */
						chat: z
							.object({ conversation_id: z.string().uuid(), agent_id: z.string().uuid() })
							.optional(),
					}),
				},
			},
			required: false,
		},
	},
	responses: {
		200: {
			description: 'Approved',
			content: {
				'application/json': {
					schema: z.object({ approval_id: z.number(), preview: objectPreviewSchema }),
				},
			},
		},
		400: {
			description: 'Cannot be approved yet',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: { description: 'Not a person', content: { 'application/json': { schema: errorSchema } } },
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: { description: 'Draft changed', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(approveRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json') ?? {}

	const [object] = await db.select().from(objects).where(eq(objects.id, id)).limit(1)
	if (!object || !(await isWorkspaceWriter(db, actorId, object.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}

	const [actor] = await db
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)
	if (actor?.type !== 'human') {
		return c.json(
			createApiError(
				'FORBIDDEN',
				'Only a person can approve a draft for sending.',
				undefined,
				'Ask the person to approve it from the card, then call the send tool.',
			),
			403,
		)
	}

	const preview = buildObjectPreview(object)
	if (!preview) {
		return c.json(
			createApiError('BAD_REQUEST', 'This object is not a draft an integration can send.'),
			400,
		)
	}
	if (preview.missing.length > 0) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				`It cannot be approved yet. Missing: ${preview.missing.join(', ')}.`,
			),
			400,
		)
	}
	if (body.content_hash && body.content_hash !== preview.content_hash) {
		return c.json(
			createApiError(
				'CONFLICT',
				'The draft changed after you opened it. Read it again before approving.',
			),
			409,
		)
	}

	const approval = await recordObjectApproval(db, {
		workspaceId: object.workspaceId,
		actorId,
		objectId: object.id,
		objectType: object.type,
		preview,
		via: 'approval',
	})

	if (body.chat) {
		// Not awaited: the approval is saved, and waking the agent may start its session.
		void wakeAgentFromCard({
			db,
			sessionManager: c.get('sessionManager'),
			workspaceId: object.workspaceId,
			callerId: actorId,
			card: body.chat,
			instruction: approvedInstruction(object, preview.body),
		})
	}

	return c.json(
		{
			approval_id: Number(approval.id),
			preview: await withDeliveryState(db, object.workspaceId, object.id, preview),
		},
		200,
	)
})

export default app
