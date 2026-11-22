import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { providerParamsSchema } from '@maskin/shared'
import type { Context } from 'hono'
import { createApiError, validationFailureHook } from '../lib/errors'
import { CredentialValueError } from '../lib/integrations/credential-value'
import {
	OAuthAppInUseError,
	deleteOAuthApp,
	getOAuthAppStatus,
	saveOAuthApp,
} from '../lib/integrations/oauth-app'
import { getProvider } from '../lib/integrations/registry'
import { getKmsProvider } from '../lib/keychain-kms'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole, isWorkspaceHumanAdminOrOwner } from '../lib/workspace-auth'
import { buildRedirectUri, providerVisible } from './integrations'
import { type Env, readSecretBody } from './integrations-keychain'

// The paste form for a workspace's own sign-in app (OAuth2Config.customerApp). Mounted on the
// same prefix as the integrations router, in its own file so that router stays untouched.
//
// In the OpenAPI document so the iPhone app's generated client has them. The viewer gate is the
// 'x-viewer-policy' tag on the two write routes, and the handler also checks for a person.
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const putBodySchema = z
	.object({
		clientId: z.string().trim().min(1).max(1024),
		clientSecret: z.string().min(1).max(1024),
	})
	.strict()

const appStatusSchema = z.object({
	configured: z.boolean(),
	clientId: z.string().optional(),
	updatedAt: z.string().optional(),
	/** The URL the vendor's app must list as its callback. */
	callbackUrl: z.string(),
})

const appRouteResponses = {
	400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
	403: { description: 'Not allowed', content: { 'application/json': { schema: errorSchema } } },
	404: {
		description: 'Unknown provider',
		content: { 'application/json': { schema: errorSchema } },
	},
}

type Guard =
	| { ok: true; displayName: string }
	| {
			ok: false
			status: 400 | 403 | 404
			code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND'
			message: string
	  }

// A person only, and for a change an admin or owner: the app signs every member of the workspace in.
async function guard(
	c: Context<Env>,
	db: Database,
	providerName: string,
	workspaceId: string,
	requireAdmin: boolean,
): Promise<Guard> {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const actorId = c.get('actorId')
	if (c.get('actorType') !== 'human') {
		return {
			ok: false,
			status: 403,
			code: 'FORBIDDEN',
			message: 'Only a person can manage a sign-in app',
		}
	}
	const unknown = {
		ok: false,
		status: 404,
		code: 'NOT_FOUND',
		message: `Unknown provider: ${providerName}`,
	} as const
	if (!providerVisible(providerName, actorId)) return unknown
	let resolved: ReturnType<typeof getProvider>
	try {
		resolved = getProvider(providerName)
	} catch {
		return unknown
	}
	const { auth, displayName } = resolved.config
	if (auth.type !== 'oauth2' || !auth.config.customerApp) {
		return {
			ok: false,
			status: 400,
			code: 'BAD_REQUEST',
			message: `${displayName} does not take a sign-in app from the customer`,
		}
	}
	if (requireAdmin && !(await isWorkspaceHumanAdminOrOwner(db, actorId, workspaceId))) {
		return {
			ok: false,
			status: 403,
			code: 'FORBIDDEN',
			message: 'Only a workspace admin or owner can change the sign-in app',
		}
	}
	return { ok: true, displayName }
}

async function statusBody(c: Context<Env>, db: Database, workspaceId: string, provider: string) {
	const status = await getOAuthAppStatus(db, workspaceId, provider)
	// The URL the vendor's app must list as its callback.
	return { ...status, callbackUrl: buildRedirectUri(c.req.url, provider, c.req.header()) }
}

// GET /api/integrations/:provider/app: whether a workspace saved its own app, and its app id. Never the secret.
const getAppRoute = createRoute({
	method: 'get',
	path: '/{provider}/app',
	tags: ['integrations'],
	summary: "Read a workspace's own sign-in app for a tool (app id only, never the secret)",
	request: { params: providerParamsSchema, headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Whether an app is saved, and its app id',
			content: { 'application/json': { schema: appStatusSchema } },
		},
		...appRouteResponses,
	},
})

app.openapi(getAppRoute, (async (c) => {
	const db = c.get('db')
	const { provider } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const guarded = await guard(c, db, provider, workspaceId, false)
	if (!guarded.ok) return c.json(createApiError(guarded.code, guarded.message), guarded.status)
	return c.json(await statusBody(c, db, workspaceId, provider), 200)
}) as RouteHandler<typeof getAppRoute, Env>)

// PUT /api/integrations/:provider/app: save or replace the app (workspace admins and owners only).
const putAppRoute = createRoute({
	method: 'put',
	path: '/{provider}/app',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: "Save or replace a workspace's own sign-in app for a tool (admins and owners only)",
	request: {
		params: providerParamsSchema,
		headers: workspaceIdHeader,
		// The handler still reads the bytes itself (readSecretBody). The body is declared so the
		// generated clients can send it; the schema only ever names fields, never echoes a value.
		body: { required: true, content: { 'application/json': { schema: putBodySchema } } },
	},
	responses: {
		200: {
			description: 'Saved. The secret is not returned',
			content: { 'application/json': { schema: appStatusSchema } },
		},
		...appRouteResponses,
	},
})

app.openapi(putAppRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { provider } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const guarded = await guard(c, db, provider, workspaceId, true)
	if (!guarded.ok) return c.json(createApiError(guarded.code, guarded.message), guarded.status)

	const parsed = await readSecretBody(c, putBodySchema)
	if (!parsed.ok) return c.json(createApiError('BAD_REQUEST', parsed.message), 400)

	try {
		await saveOAuthApp(db, getKmsProvider(), {
			workspaceId,
			actorId,
			provider,
			displayName: `${guarded.displayName} app`,
			clientId: parsed.data.clientId,
			clientSecret: parsed.data.clientSecret,
		})
	} catch (err) {
		if (err instanceof CredentialValueError) {
			return c.json(createApiError(err.code, err.message), err.status)
		}
		if (err instanceof OAuthAppInUseError) {
			return c.json(
				createApiError(
					'CONFLICT',
					`Disconnect ${guarded.displayName} first: it is signed in with the saved app, so a different app id would strand it. The same app id with a new secret is fine`,
				),
				409,
			)
		}
		// Error name only, never the request: a driver error can carry bound params.
		logger.error('Saving a sign-in app failed', {
			workspaceId,
			provider,
			error: err instanceof Error ? err.name : 'unknown',
		})
		throw err
	}
	return c.json(await statusBody(c, db, workspaceId, provider), 200)
}) as RouteHandler<typeof putAppRoute, Env>)

// DELETE /api/integrations/:provider/app: remove the app (refused while the tool is connected).
const deleteAppRoute = createRoute({
	method: 'delete',
	path: '/{provider}/app',
	'x-viewer-policy': 'writer',
	tags: ['integrations'],
	summary: "Remove a workspace's own sign-in app for a tool (refused while the tool is connected)",
	request: { params: providerParamsSchema, headers: workspaceIdHeader },
	responses: {
		204: { description: 'Removed' },
		...appRouteResponses,
		409: {
			description: 'The tool is still connected and signs in and renews with this app',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(deleteAppRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { provider } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const guarded = await guard(c, db, provider, workspaceId, true)
	if (!guarded.ok) return c.json(createApiError(guarded.code, guarded.message), guarded.status)

	const outcome = await deleteOAuthApp(db, { workspaceId, actorId, provider })
	if (outcome === 'not_found') {
		return c.json(createApiError('NOT_FOUND', 'No sign-in app is saved for this tool'), 404)
	}
	if (outcome === 'in_use') {
		return c.json(
			createApiError(
				'CONFLICT',
				`Disconnect ${guarded.displayName} first: it still signs in and renews with this app`,
			),
			409,
		)
	}
	return c.body(null, 204)
}) as RouteHandler<typeof deleteAppRoute, Env>)

export default app
