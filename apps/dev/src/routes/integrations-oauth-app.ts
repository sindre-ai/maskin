import { OpenAPIHono, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import type { Context } from 'hono'
import { createApiError, validationFailureHook } from '../lib/errors'
import { CredentialValueError } from '../lib/integrations/credential-value'
import { deleteOAuthApp, getOAuthAppStatus, saveOAuthApp } from '../lib/integrations/oauth-app'
import { getProvider } from '../lib/integrations/registry'
import { getKmsProvider } from '../lib/keychain-kms'
import { logger } from '../lib/logger'
import { assertWorkspaceWriterRole, isWorkspaceHumanAdminOrOwner } from '../lib/workspace-auth'
import { buildRedirectUri, providerVisible } from './integrations'
import { type Env, readSecretBody } from './integrations-keychain'

// The paste form for a workspace's own sign-in app (OAuth2Config.customerApp). Mounted on the
// same prefix as the integrations router, in its own file so that router stays untouched.
//
// Built as plain Hono routes, not createRoute: the Apple client is generated from the OpenAPI
// document and cannot be regenerated without a Swift toolchain, so the document is left alone
// until the iOS form is built. The viewer gate is in the handler (HAND_GATED_ROUTES).
const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const putBodySchema = z
	.object({
		clientId: z.string().trim().min(1).max(1024),
		clientSecret: z.string().min(1).max(1024),
	})
	.strict()

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

function workspaceIdOf(c: Context<Env>): string | null {
	const parsed = z.string().uuid().safeParse(c.req.header('x-workspace-id'))
	return parsed.success ? parsed.data : null
}

async function statusBody(c: Context<Env>, db: Database, workspaceId: string, provider: string) {
	const status = await getOAuthAppStatus(db, workspaceId, provider)
	// The URL the vendor's app must list as its callback.
	return { ...status, callbackUrl: buildRedirectUri(c.req.url, provider, c.req.header()) }
}

// GET /api/integrations/:provider/app: whether a workspace saved its own app, and its app id. Never the secret.
app.get('/:provider/app', async (c) => {
	const db = c.get('db')
	const provider = c.req.param('provider')
	const workspaceId = workspaceIdOf(c)
	if (!workspaceId) return c.json(createApiError('BAD_REQUEST', 'X-Workspace-Id is required'), 400)
	const guarded = await guard(c, db, provider, workspaceId, false)
	if (!guarded.ok) return c.json(createApiError(guarded.code, guarded.message), guarded.status)
	return c.json(await statusBody(c, db, workspaceId, provider), 200)
})

// PUT /api/integrations/:provider/app: save or replace the app (workspace admins and owners only).
app.put('/:provider/app', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const provider = c.req.param('provider')
	const workspaceId = workspaceIdOf(c)
	if (!workspaceId) return c.json(createApiError('BAD_REQUEST', 'X-Workspace-Id is required'), 400)
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
		// Error name only, never the request: a driver error can carry bound params.
		logger.error('Saving a sign-in app failed', {
			workspaceId,
			provider,
			error: err instanceof Error ? err.name : 'unknown',
		})
		throw err
	}
	return c.json(await statusBody(c, db, workspaceId, provider), 200)
})

// DELETE /api/integrations/:provider/app: remove the app (refused while the tool is connected).
app.delete('/:provider/app', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const provider = c.req.param('provider')
	const workspaceId = workspaceIdOf(c)
	if (!workspaceId) return c.json(createApiError('BAD_REQUEST', 'X-Workspace-Id is required'), 400)
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
})

export default app
