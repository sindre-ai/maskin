import { randomUUID } from 'node:crypto'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { trackIntegrationConnected } from '../lib/analytics/integration-events'
import { encryptEnvelope } from '../lib/crypto'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { insertCredentialAccessLog } from '../lib/integrations/credential-audit'
import {
	WordPressError,
	discoverSite,
	fromTransportError,
	whoAmI,
} from '../lib/integrations/providers/wordpress-self-hosted/client'
import { WORDPRESS_SELF_HOSTED_PROVIDER } from '../lib/integrations/providers/wordpress-self-hosted/config'
import {
	WORDPRESS_PASSWORD_MAX_LENGTH,
	WORDPRESS_USERNAME_MAX_LENGTH,
	type WordPressCredentials,
	cleanApplicationPassword,
	encodeWordPressCredentials,
	normalizeSiteUrl,
	siteLabel,
} from '../lib/integrations/providers/wordpress-self-hosted/credentials'
import { SafeFetchError } from '../lib/integrations/safe-fetch'
import { getKmsProvider } from '../lib/keychain-kms'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'
import { providerVisible } from './integrations'

// A self-hosted WordPress site connects from a three-field form (site address, username,
// application password), not a redirect. Mounted before the generic /api/integrations routes, like
// the other providers that have their own. The tools are in lib/integrations/providers/
// wordpress-self-hosted/mcp-server.ts.

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

const PROVIDER = WORDPRESS_SELF_HOSTED_PROVIDER

const connectBodySchema = z.object({
	site_url: z.string().trim().min(1).max(500),
	username: z.string().trim().min(1).max(WORDPRESS_USERNAME_MAX_LENGTH),
	application_password: z.string().min(1).max(WORDPRESS_PASSWORD_MAX_LENGTH),
})

const connectRoute = createRoute({
	method: 'post',
	path: '/connect',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: 'Connect a self-hosted WordPress site with an application password',
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
			description: 'The site or the sign-in was refused. Nothing is stored.',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Not available',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Another site is already connected in this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Signed in, but the connection could not be saved',
			content: { 'application/json': { schema: errorSchema } },
		},
		502: {
			description: 'The site could not be reached. Nothing is stored.',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(connectRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	assertWorkspaceWriterRole(c.get('workspaceRole'))

	// Off for everyone but the testers of its flag: the same answer as a provider that does not exist.
	if (!providerVisible(PROVIDER, actorId)) {
		return c.json(createApiError('NOT_FOUND', `Unknown provider: ${PROVIDER}`), 404)
	}

	const body = c.req.valid('json')
	let siteUrl: string
	try {
		siteUrl = normalizeSiteUrl(body.site_url)
	} catch (err) {
		const message = err instanceof SafeFetchError ? err.message : 'That is not a valid web address.'
		return c.json(createApiError('BAD_REQUEST', message), 400)
	}
	const label = siteLabel(siteUrl)

	// One site per workspace in this version: agents reach the oldest active connection. Connecting
	// the same site again replaces its login.
	const [existing] = await db
		.select({ id: integrations.id, externalId: integrations.externalId })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, PROVIDER),
				eq(integrations.providerMode, 'registered'),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)
		.limit(1)
	if (existing && existing.externalId !== label) {
		return c.json(
			createApiError(
				'CONFLICT',
				'A WordPress site is already connected in this workspace. Disconnect it first to connect another.',
			),
			409,
		)
	}

	// Check the site and the sign-in first and store only if both work, so a wrong password never
	// leaves a row that looks connected. Nothing from the body goes into a log or an event.
	let credentials: WordPressCredentials
	try {
		const info = await discoverSite(siteUrl)
		if (info.application_passwords === false) {
			throw new WordPressError(
				'APP_PASSWORDS_OFF',
				'This site does not offer application passwords. They need WordPress 5.6 or newer on https, and some hosts or security plugins turn them off.',
			)
		}
		credentials = {
			site_url: siteUrl,
			username: body.username,
			application_password: cleanApplicationPassword(body.application_password),
			rest_style: info.rest_style,
		}
		await whoAmI(credentials)
	} catch (err) {
		const failure = err instanceof WordPressError ? err : fromTransportError(err)
		logger.warn('WordPress check at connect did not pass', { workspaceId, code: failure.code })
		const unreachable = failure.code === 'NOT_REACHABLE' || failure.code === 'SITE_ERROR'
		return c.json(
			createApiError(unreachable ? 'INTERNAL_ERROR' : 'BAD_REQUEST', failure.message),
			unreachable ? 502 : 400,
		)
	}

	// Envelope encryption: the Keychain way, not the older single-key encrypt().
	const kms = getKmsProvider()
	const sealed = await encryptEnvelope(kms, workspaceId, encodeWordPressCredentials(credentials))

	let integrationId: string
	try {
		integrationId = await db.transaction(async (tx) => {
			let id = existing?.id
			if (id) {
				await tx
					.update(integrations)
					.set({
						status: INTEGRATION_STATUS_ACTIVE,
						credentials: sealed.credentials,
						dekCiphertext: sealed.dekCiphertext,
						updatedAt: new Date(),
					})
					.where(and(eq(integrations.id, id), eq(integrations.workspaceId, workspaceId)))
			} else {
				id = randomUUID()
				await tx.insert(integrations).values({
					id,
					workspaceId,
					provider: PROVIDER,
					status: INTEGRATION_STATUS_ACTIVE,
					externalId: label,
					credentials: sealed.credentials,
					dekCiphertext: sealed.dekCiphertext,
					providerMode: 'registered',
					// Explicit grant only: this login can edit a customer's site.
					defaultAgentAccess: 'none',
					source: 'admin_ui',
					createdBy: actorId,
				})
			}
			await insertCredentialAccessLog(tx, {
				workspaceId,
				integrationId: id,
				actorId,
				action: existing ? 'rotated' : 'create',
				source: 'admin_ui',
				requestId: `wordpress-connect:${id}`,
			})
			await recordEvent(tx, {
				workspaceId,
				actorId,
				action: existing ? 'updated' : 'created',
				entityType: 'integration',
				entityId: id,
				// Never the username, the password, the ciphertext or the wrapped key.
				data: { provider: PROVIDER, external_id: label, auth_type: 'manual' },
			})
			return id
		})
	} catch (err) {
		// A concurrent connect of the same site loses the unique index; say so once.
		logger.error('WordPress connection could not be saved', {
			workspaceId,
			error: err instanceof Error ? err.name : 'unknown',
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to save the connection'), 500)
	}

	logger.info('WordPress (self-hosted) connected', { workspaceId, integrationId })
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
