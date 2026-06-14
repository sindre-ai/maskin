import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { createApiError } from '../lib/errors'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import {
	InvalidEmailError,
	WorkspaceNotFoundError,
	upsertContactByEmail,
} from '../services/attendee-contact'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

const upsertContactRequestSchema = z
	.object({
		email: z
			.string()
			.email()
			.describe('Attendee email — used as the deterministic match key (case-insensitive).'),
		name: z
			.string()
			.trim()
			.min(1)
			.optional()
			.describe('Display name. Sets the contact title when creating; ignored on match.'),
		meeting_id: z
			.string()
			.uuid()
			.optional()
			.describe('If set, also create a `meeting—attended_by→contact` relationship.'),
	})
	.openapi('UpsertContactRequest')

const upsertContactResponseSchema = z
	.object({
		contact_id: z.string().uuid(),
		created: z.boolean().describe('True if a new contact was inserted, false if matched by email.'),
		crm_auto_enabled: z
			.boolean()
			.describe('True if this call enabled the `crm` module on the workspace.'),
		notification_id: z
			.string()
			.uuid()
			.nullable()
			.describe('Id of the user-facing notification emitted when CRM was auto-enabled.'),
		attended_by_relationship_id: z
			.string()
			.uuid()
			.nullable()
			.describe('Id of the meeting→contact `attended_by` relationship, if `meeting_id` was set.'),
	})
	.openapi('UpsertContactResponse')

const upsertContactRoute = createRoute({
	method: 'post',
	path: '/upsert',
	tags: ['contacts'],
	summary: 'Deterministic attendee→contact upsert',
	description:
		'Match a contact by lowercased email or create one. On first use in a workspace, auto-enables the `crm` module and emits a user-facing notification. Idempotent: a duplicate call with the same email and meeting_id returns the same ids without inserting.',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': { schema: upsertContactRequestSchema },
			},
		},
	},
	responses: {
		200: {
			description: 'Contact upserted',
			content: { 'application/json': { schema: upsertContactResponseSchema } },
		},
		400: {
			description: 'Invalid request body',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(upsertContactRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	try {
		const result = await upsertContactByEmail({
			db,
			workspaceId,
			sourceActorId: actorId,
			email: body.email,
			name: body.name,
			meetingId: body.meeting_id,
		})
		return c.json({
			contact_id: result.contactId,
			created: result.created,
			crm_auto_enabled: result.crmAutoEnabled,
			notification_id: result.notificationId,
			attended_by_relationship_id: result.attendedByRelationshipId,
		})
	} catch (err) {
		if (err instanceof InvalidEmailError) {
			return c.json(createApiError('VALIDATION_ERROR', err.message), 400)
		}
		if (err instanceof WorkspaceNotFoundError) {
			return c.json(createApiError('NOT_FOUND', err.message), 404)
		}
		throw err
	}
}) as RouteHandler<typeof upsertContactRoute, Env>)

export default app
