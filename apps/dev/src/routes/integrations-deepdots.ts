import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, isNotNull } from 'drizzle-orm'
import { trackIntegrationConnected } from '../lib/analytics/integration-events'
import { encrypt } from '../lib/crypto'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { FLAGS, isFlagEnabled } from '../lib/feature-flags'
import { DeepdotsAuthError, signIn } from '../lib/integrations/providers/deepdots/auth'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'

// Deepdots connects from a two-field form (email and password), not a redirect or a
// pasted key. Mounted before the generic /api/integrations routes, like the other
// providers that have their own. Renewal is in lib/integrations/providers/deepdots/auth.ts.

type Env = {
	Variables: {
		db: Database
		actorId: string
		/** Caller's role in the X-Workspace-Id workspace, set by authMiddleware. */
		workspaceRole?: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const PROVIDER = 'deepdots'

const connectBodySchema = z.object({
	email: z.string().trim().min(1).max(320),
	password: z.string().min(1).max(1024),
})

const connectRoute = createRoute({
	method: 'post',
	path: '/connect',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Connect Deepdots with an email and password',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: connectBodySchema } } },
	},
	responses: {
		200: {
			description: 'Signed in and stored',
			content: { 'application/json': { schema: z.object({ integration_id: z.string() }) } },
		},
		400: {
			description: 'Deepdots refused the email and password. Nothing is stored.',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Deepdots is not switched on for this person',
			content: { 'application/json': { schema: errorSchema } },
		},
		502: {
			description: 'Deepdots could not be reached. Nothing is stored.',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(connectRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))

	if (!isFlagEnabled(actorId, FLAGS.DEEPDOTS_CONNECT)) {
		return c.json(createApiError('NOT_FOUND', 'Deepdots is not available yet'), 404)
	}

	const { email, password } = c.req.valid('json')

	// Sign in first and store only if it works, so a wrong password never leaves a
	// row that looks connected. Nothing from the body goes into a log or an event.
	let credentials: Awaited<ReturnType<typeof signIn>>
	try {
		credentials = await signIn(email, password)
	} catch (err) {
		if (err instanceof DeepdotsAuthError && err.kind === 'rejected') {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					'Deepdots did not accept this email and password. Check them and try again.',
				),
				400,
			)
		}
		logger.warn('Deepdots sign-in at connect could not complete', {
			workspaceId,
			status: err instanceof DeepdotsAuthError ? err.status : null,
		})
		return c.json(
			createApiError('INTERNAL_ERROR', 'Deepdots could not be reached. Try again in a minute.'),
			502,
		)
	}

	const externalId = email.toLowerCase()
	const encryptedCredentials = encrypt(JSON.stringify(credentials))

	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: PROVIDER,
			status: 'active',
			externalId,
			credentials: encryptedCredentials,
			createdBy: actorId,
		})
		.onConflictDoUpdate({
			target: [
				integrations.workspaceId,
				integrations.actorId,
				integrations.provider,
				integrations.externalId,
			],
			// Same partial unique index as the api_key connect in routes/integrations.ts.
			targetWhere: isNotNull(integrations.externalId),
			// Reconnecting with the same email replaces the login and brings a revoked row back.
			set: { status: 'active', credentials: encryptedCredentials, updatedAt: new Date() },
		})
		.returning({ id: integrations.id })

	let integrationId = row?.id
	if (!integrationId) {
		const [existing] = await db
			.select({ id: integrations.id })
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.provider, PROVIDER),
					eq(integrations.externalId, externalId),
				),
			)
			.limit(1)
		integrationId = existing?.id
	}
	if (!integrationId) {
		logger.error('Deepdots activation returned no id', { workspaceId })
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to activate integration'), 500)
	}

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'integration',
		entityId: integrationId,
		// Never the email's password, the token or the ciphertext.
		data: { provider: PROVIDER, external_id: externalId, auth_type: 'manual' },
	})
	logger.info('Deepdots connected', { workspaceId, integrationId })

	void trackIntegrationConnected({
		provider: PROVIDER,
		workspaceId,
		actorId,
		integrationId,
		authType: 'manual',
	})

	return c.json({ integration_id: integrationId }, 200)
})

export default app
