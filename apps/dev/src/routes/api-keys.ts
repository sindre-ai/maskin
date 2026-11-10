import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import {
	type ActorKeySummary,
	PERSONAL_KEY_CAP,
	issuePersonalKey,
	listActorKeys,
	revokeOwnKey,
} from '@maskin/auth'
import type { Database } from '@maskin/db'
import type { ApiKeyKind } from '@maskin/db/schema'
import {
	type ApiKeySummary,
	apiKeyListSchema,
	createApiKeySchema,
	createdApiKeySchema,
} from '@maskin/shared'
import { CLIENT_SOURCE_HEADER } from '../lib/analytics/knowledge-events'
import { createApiError, validationFailureHook } from '../lib/errors'
import { errorSchema } from '../lib/openapi-schemas'

// A person's own API keys, for the Keys and MCP page: list them, make a named one, revoke one.
//
// Only the signed-in person's keys are ever read or changed, and the secret is never read back:
// it is in the response to the create call and nowhere else (only its hash is stored). Keys that
// belong to agents (one per session launch) are not listed; they are minted and revoked by the
// session itself.

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		// Set by the auth middleware for ank_ keys; unset for other credentials.
		apiKeyKind?: ApiKeyKind
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/** What holds a key, where the kind says so. A personal key can be pasted anywhere, so it says nothing. */
const CONNECTION_LABELS: Record<ApiKeyKind, string | null> = {
	primary: 'Account key',
	login: 'Web sign-in',
	login_ios: 'iPhone sign-in',
	session: 'Agent session',
	personal: null,
}

function toApiKey(row: ActorKeySummary): ApiKeySummary {
	const connection = CONNECTION_LABELS[row.kind]
	return {
		id: row.id,
		kind: row.kind,
		name: row.name,
		hint: `ank_…${row.last4}`,
		created_at: row.createdAt.toISOString(),
		last_used_at: row.lastUsedAt?.toISOString() ?? null,
		expires_at: row.expiresAt?.toISOString() ?? null,
		used_by: connection ? { type: 'connection', name: connection } : null,
	}
}

const notAPerson = () => createApiError('FORBIDDEN', 'Only a person has API keys to manage')

// MARK: list

const listRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Account'],
	summary: 'My API keys',
	description:
		'The signed-in person’s live keys, newest first: name, last four characters, created, last used and what holds the key. Never the key itself.',
	responses: {
		200: {
			content: { 'application/json': { schema: apiKeyListSchema } },
			description: 'The keys',
		},
		403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not a person' },
	},
})

app.openapi(listRoute, async (c) => {
	if (c.get('actorType') !== 'human') return c.json(notAPerson(), 403)
	const keys = await listActorKeys(c.get('db'), c.get('actorId'))
	return c.json({ keys: keys.map(toApiKey) }, 200)
})

// MARK: create

const createKeyRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Account'],
	summary: 'Make a named API key',
	description: `Makes a personal key with the given name. The secret is in this response and nowhere else: only its hash is stored, so it cannot be shown again. A person may hold ${PERSONAL_KEY_CAP} personal keys at once. Refused from an MCP client and from a personal key, because there a model holds the person’s key and could otherwise make itself more.`,
	request: {
		body: { content: { 'application/json': { schema: createApiKeySchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: createdApiKeySchema } },
			description: 'The new key, with its secret shown once',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Not a person, called from an MCP client, or called with a personal key',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Already at the limit of personal keys',
		},
	},
})

app.openapi(createKeyRoute, async (c) => {
	if (c.get('actorType') !== 'human') return c.json(notAPerson(), 403)
	if (c.req.header(CLIENT_SOURCE_HEADER) === 'mcp') {
		return c.json(createApiError('FORBIDDEN', 'API keys are made from the app, not over MCP'), 403)
	}
	// The header above is only a label the client sends. This is the real guard: a personal key
	// is the kind pasted into other tools, so it cannot be used to make more of itself.
	if (c.get('apiKeyKind') === 'personal') {
		return c.json(
			createApiError('FORBIDDEN', 'A personal key cannot make more keys. Use the app to make one.'),
			403,
		)
	}
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { name } = c.req.valid('json')

	const issued = await issuePersonalKey(db, actorId, name)
	if (!issued) {
		return c.json(
			createApiError(
				'CONFLICT',
				`You already have ${PERSONAL_KEY_CAP} personal keys. Revoke one to make another.`,
			),
			409,
		)
	}
	const created = (await listActorKeys(db, actorId)).find((k) => k.id === issued.id)
	if (!created) throw new Error('A key was made but could not be read back')
	return c.json({ key: toApiKey(created), secret: issued.key }, 201)
})

// MARK: revoke

const revokeRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['Account'],
	summary: 'Revoke one of my API keys',
	description:
		'Revokes a live key of the signed-in person. It stops working on the next request. Another person’s key id, or one already revoked, is a 404.',
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ revoked: z.literal(true) }) } },
			description: 'Revoked',
		},
		403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not a person' },
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'No such key' },
	},
})

app.openapi(revokeRoute, async (c) => {
	if (c.get('actorType') !== 'human') return c.json(notAPerson(), 403)
	const { id } = c.req.valid('param')
	const revoked = await revokeOwnKey(c.get('db'), c.get('actorId'), id)
	if (!revoked) return c.json(createApiError('NOT_FOUND', 'No such key'), 404)
	return c.json({ revoked: true as const }, 200)
})

export default app
