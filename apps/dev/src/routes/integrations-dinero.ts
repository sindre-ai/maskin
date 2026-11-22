import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, isNotNull } from 'drizzle-orm'
import { trackIntegrationConnected } from '../lib/analytics/integration-events'
import { encrypt } from '../lib/crypto'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { FLAGS, isFlagEnabled } from '../lib/feature-flags'
import { buildRequest, trimOrganization } from '../lib/integrations/providers/dinero/api'
import { DineroAuthError, requestToken } from '../lib/integrations/providers/dinero/auth'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'

// Dinero connects from a three-field form (client id, client secret and API key from a
// personal integration), not a redirect or one pasted key. Mounted before the generic
// /api/integrations routes, like the other providers that have their own. The one-hour token
// is renewed in lib/integrations/providers/dinero/auth.ts.

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

const PROVIDER = 'dinero'

const connectBodySchema = z.object({
	client_id: z.string().trim().min(1).max(256),
	client_secret: z.string().trim().min(1).max(1024),
	api_key: z.string().trim().min(1).max(1024),
	/** Only when the keys can see several companies. Dinero shows it in the address bar. */
	organization_id: z.number().int().positive().optional(),
})

const connectRoute = createRoute({
	method: 'post',
	path: '/connect',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Connect Dinero with a client id, client secret and API key',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: connectBodySchema } } },
	},
	responses: {
		200: {
			description: 'Signed in and stored',
			content: {
				'application/json': {
					schema: z.object({ integration_id: z.string(), company_name: z.string().nullable() }),
				},
			},
		},
		400: {
			description:
				'Dinero refused the keys, the company has no Pro or Total plan, or the company is unclear. Nothing is stored.',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Signed in, but the connection could not be saved',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Dinero is not switched on for this person',
			content: { 'application/json': { schema: errorSchema } },
		},
		502: {
			description: 'Dinero could not be reached. Nothing is stored.',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(connectRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))

	if (!isFlagEnabled(actorId, FLAGS.DINERO_CONNECT)) {
		return c.json(createApiError('NOT_FOUND', 'Dinero is not available yet'), 404)
	}

	const body = c.req.valid('json')
	const keys = { clientId: body.client_id, clientSecret: body.client_secret, apiKey: body.api_key }

	// Sign in first and store only if it works, so a wrong key never leaves a row that looks
	// connected. Nothing from the body goes into a log or an event.
	let token: Awaited<ReturnType<typeof requestToken>>
	try {
		token = await requestToken(keys)
	} catch (err) {
		if (err instanceof DineroAuthError && err.kind === 'rejected') {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					'Dinero did not accept these keys. Check the client id, client secret and API key, and that Dinero has approved the credentials.',
				),
				400,
			)
		}
		logger.warn('Dinero sign-in at connect could not complete', {
			workspaceId,
			status: err instanceof DineroAuthError ? err.status : null,
		})
		return c.json(
			createApiError('INTERNAL_ERROR', 'Dinero could not be reached. Try again in a minute.'),
			502,
		)
	}

	// Which company the keys are for. A personal integration is made for one company, so the
	// list is usually one row; a Pro or Total plan is also checked here (Dinero answers 403).
	let companies: Array<{ organization_id: number; name: string | null }> = []
	try {
		const req = buildRequest(0, { op: 'list_organizations' })
		const res = await fetch(req.url, {
			method: req.method,
			headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' },
			signal: AbortSignal.timeout(15_000),
		})
		if (res.status === 403) {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					'Dinero accepted the keys, but the company has no Pro or Total plan, which the API needs.',
				),
				400,
			)
		}
		if (!res.ok) throw new Error(`status ${res.status}`)
		const list = (await res.json()) as unknown
		if (Array.isArray(list)) {
			for (const row of list) {
				const org = trimOrganization(row)
				if (org && org.organization_id !== null) {
					companies.push({ organization_id: org.organization_id, name: org.name })
				}
			}
		}
	} catch (err) {
		logger.warn('Dinero company lookup at connect could not complete', {
			workspaceId,
			error: err instanceof Error ? err.name : 'unknown',
		})
		return c.json(
			createApiError('INTERNAL_ERROR', 'Dinero could not be reached. Try again in a minute.'),
			502,
		)
	}
	if (body.organization_id !== undefined) {
		companies = companies.filter((o) => o.organization_id === body.organization_id)
	}
	const company = companies.length === 1 ? companies[0] : undefined
	if (!company) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				companies.length === 0
					? 'Dinero accepted the keys but showed no company for them.'
					: 'These keys can see more than one company. Add the company id from the Dinero address bar to pick one.',
			),
			400,
		)
	}

	const externalId = String(company.organization_id)
	const encryptedCredentials = encrypt(
		JSON.stringify({
			...keys,
			organizationId: company.organization_id,
			accessToken: token.accessToken,
			expiresAt: token.expiresAt,
			tokenType: token.tokenType,
		}),
	)

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
			// Reconnecting the same company replaces the keys and brings a revoked row back.
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
		logger.error('Dinero activation returned no id', { workspaceId })
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to activate integration'), 500)
	}

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'integration',
		entityId: integrationId,
		// Never the keys, the token or the ciphertext.
		data: { provider: PROVIDER, external_id: externalId, auth_type: 'manual' },
	})
	logger.info('Dinero connected', { workspaceId, integrationId })

	void trackIntegrationConnected({
		provider: PROVIDER,
		workspaceId,
		actorId,
		integrationId,
		authType: 'manual',
	})

	return c.json({ integration_id: integrationId, company_name: company.name }, 200)
})

export default app
