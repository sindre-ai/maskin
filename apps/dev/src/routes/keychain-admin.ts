import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { createApiError, validationFailureHook } from '../lib/errors'
import { CredentialValueError } from '../lib/integrations/credential-value'
import { applyLift, planLift, undoLift } from '../lib/integrations/keychain-lift'
import { replaceCredentialValue } from '../lib/integrations/replace-value'
import { getKmsProvider } from '../lib/keychain-kms'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole, isWorkspaceHumanAdminOrOwner } from '../lib/workspace-auth'
import { type Env, readSecretBody } from './integrations-keychain'

// Keychain operations only a human workspace admin or owner may run. Deliberately not
// an MCP tool: nothing in packages/mcp calls these, so no agent can reach them.
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// ── POST /api/keychain/lift ──────────────────────────────────────────────

const liftBodySchema = z
	.object({
		apply: z.literal(true).optional(),
		undo_event_id: z.string().regex(/^\d+$/).optional(),
	})
	.strict()
	.refine((b) => !(b.apply && b.undo_event_id), 'Send apply or undo_event_id, not both')

const liftEntrySchema = z.object({
	integrationId: z.string().uuid(),
	serverName: z.string(),
	location: z.enum(['env', 'headers', 'args', 'url']),
	field: z.string(),
	provider: z.string(),
	keyName: z.string().nullable(),
	actorIds: z.array(z.string().uuid()),
	status: z.enum(['would_lift', 'cannot_lift']),
	reason: z.string().optional(),
})

const liftResponseSchema = z.union([
	z.object({
		dryRun: z.literal(true),
		keys: z.array(
			z.object({ keyName: z.string(), entries: z.number(), actorIds: z.array(z.string().uuid()) }),
		),
		entries: z.array(liftEntrySchema),
		agentConfigFindings: z.array(
			z.object({
				actorId: z.string().uuid(),
				serverName: z.string(),
				location: z.enum(['env', 'headers']),
				field: z.string(),
			}),
		),
	}),
	z.object({
		dryRun: z.literal(false),
		results: z.array(
			z.object({
				keyName: z.string(),
				status: z.enum(['lifted', 'aborted']),
				integrationId: z.string().uuid().optional(),
				eventId: z.string().optional(),
				entries: z.number().optional(),
				reason: z.string().optional(),
			}),
		),
	}),
	z.object({ undone: z.literal(true), restored: z.number(), skipped: z.number() }),
])

// No `request.body` on purpose: the body is optional (no body is the dry run), which the
// request validator cannot express. The handler reads it and checks it against the schema.
const liftRoute = createRoute({
	method: 'post',
	path: '/lift',
	'x-viewer-policy': 'writer',
	tags: ['keychain'],
	summary:
		'Move tokens from tool servers into saved keys (admin only). No body: dry run. {apply: true}: apply. {undo_event_id}: undo one lift',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description:
				'Dry run: what would move (names and agents, never values). Apply: one result per key. Undo: what was restored',
			content: { 'application/json': { schema: liftResponseSchema } },
		},
		400: { description: 'Invalid body', content: { 'application/json': { schema: errorSchema } } },
		403: {
			description: 'Only a human workspace admin or owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: { description: 'No such lift', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'The lift was already undone, or its key is gone',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(liftRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))

	// Before the body is read: an agent gets nothing about what is in the workspace.
	if (!(await isWorkspaceHumanAdminOrOwner(db, callerId, workspaceId))) {
		return c.json(
			createApiError(
				'FORBIDDEN',
				'Only a workspace admin or owner can lift tokens into the Keychain',
			),
			403,
		)
	}

	const text = (await c.req.text()).trim()
	let body: z.infer<typeof liftBodySchema> = {}
	if (text !== '') {
		let json: unknown
		try {
			json = JSON.parse(text)
		} catch {
			return c.json(createApiError('BAD_REQUEST', 'Body must be valid JSON'), 400)
		}
		const parsed = liftBodySchema.safeParse(json)
		if (!parsed.success) {
			return c.json(
				createApiError('BAD_REQUEST', 'Send {"apply": true} or {"undo_event_id": "…"}'),
				400,
			)
		}
		body = parsed.data
	}

	if (body.undo_event_id) {
		const outcome = await undoLift(db, getKmsProvider(), {
			workspaceId,
			actorId: callerId,
			eventId: body.undo_event_id,
		})
		if (outcome.kind === 'not_found') {
			return c.json(createApiError('NOT_FOUND', 'No lift with that event id'), 404)
		}
		if (outcome.kind === 'already_undone') {
			return c.json(createApiError('CONFLICT', 'This lift was already undone'), 409)
		}
		if (outcome.kind === 'key_gone') {
			return c.json(
				createApiError('CONFLICT', 'The saved key from this lift is no longer there'),
				409,
			)
		}
		return c.json(
			{ undone: true as const, restored: outcome.restored, skipped: outcome.skipped },
			200,
		)
	}

	if (body.apply) {
		const results = await applyLift(db, getKmsProvider(), { workspaceId, actorId: callerId })
		return c.json({ dryRun: false as const, results }, 200)
	}

	const { report } = await planLift(db, workspaceId)
	return c.json({ dryRun: true as const, ...report }, 200)
}) as RouteHandler<typeof liftRoute, Env>)

// ── POST /api/keychain/credentials/:id/replace-value ─────────────────────

const replaceBodySchema = z.object({ rawSecret: z.string().min(1).max(4096) }).strict()

// No `request.body` on purpose, same as the paste form: the handler reads the raw buffer so
// it can zero it once the secret is parsed.
const replaceValueRoute = createRoute({
	method: 'post',
	path: '/credentials/{id}/replace-value',
	'x-viewer-policy': 'writer',
	tags: ['keychain'],
	summary: 'Replace the value of a saved API key in place (admin only)',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			description:
				'Replaced. The key keeps its id, name and grants. Running sessions keep the old value, the next launch gets the new one',
			content: {
				'application/json': {
					schema: z.object({ id: z.string().uuid(), status: z.literal('replaced') }),
				},
			},
		},
		400: { description: 'Invalid value', content: { 'application/json': { schema: errorSchema } } },
		403: {
			description: 'Only a human workspace admin or owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
		409: {
			description: 'Not an API key, or not active (undone or waiting out its undo window)',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(replaceValueRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const { id } = c.req.valid('param')

	if (!(await isWorkspaceHumanAdminOrOwner(db, callerId, workspaceId))) {
		return c.json(
			createApiError('FORBIDDEN', 'Only a workspace admin or owner can replace a key value'),
			403,
		)
	}

	const body = await readSecretBody(c, replaceBodySchema)
	if (!body.ok) return c.json(createApiError('BAD_REQUEST', body.message), 400)

	try {
		const outcome = await replaceCredentialValue(db, getKmsProvider(), {
			workspaceId,
			integrationId: id,
			actorId: callerId,
			rawSecret: body.data.rawSecret,
		})
		if (outcome === 'not_found') {
			return c.json(createApiError('NOT_FOUND', 'Integration not found'), 404)
		}
		if (outcome === 'not_api_key') {
			return c.json(createApiError('CONFLICT', 'This is not a saved API key'), 409)
		}
		if (outcome === 'not_active') {
			return c.json(
				createApiError('CONFLICT', 'This key is not active, so its value cannot be replaced'),
				409,
			)
		}
		return c.json({ id, status: 'replaced' as const }, 200)
	} catch (err) {
		if (err instanceof CredentialValueError) {
			return c.json(createApiError(err.code, err.message), err.status)
		}
		// Error name only, never the request: a driver error can carry bound params.
		logger.error('Replace key value failed', {
			workspaceId,
			integrationId: id,
			error: err instanceof Error ? err.name : 'unknown',
		})
		throw err
	}
}) as RouteHandler<typeof replaceValueRoute, Env>)

export default app
