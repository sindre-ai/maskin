import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import {
	desktopExecBodySchema,
	desktopExecResultSchema,
	desktopInputActionSchema,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { resolveDesktopAgent } from '../lib/desktop-access'
import { signDesktopTicket } from '../lib/desktop-ticket'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { resolveKeychainTyping } from '../lib/integrations/keychain-typing'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { assertWorkspaceWriterRole } from '../lib/workspace-auth'
import { DESKTOP_STREAM_PATH } from '../services/desktop-relay'
import {
	type WorkspaceDesktopService,
	createWorkspaceDesktopService,
} from '../services/workspace-desktop'

// Every agent has its own computer. These routes are workspace-scoped via
// X-Workspace-Id (authMiddleware has already confirmed the caller is a member of
// that workspace) and agent-scoped via `?agent_id=`:
//   • an agent calls them with its own API key and gets ITS desktop — it may omit
//     agent_id, and naming any other agent is refused (403);
//   • a person must say whose computer they mean, and may name any agent in the
//     workspace (to watch, take over or teach it).
// The rule itself lives in lib/desktop-access.ts.
type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType?: string
		workspaceRole?: string
		// Test seam: unit tests inject a fake instead of hitting agent-servers.
		desktopService?: WorkspaceDesktopService
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const agentQuery = z.object({
	agent_id: z.string().uuid().optional().openapi({
		description:
			'Whose computer. Required for people; an agent may omit it (it is its own) and may not name another.',
	}),
})

const connectResponseSchema = z.object({
	ticket: z.string().openapi({ description: 'One-time ticket, valid for 30 seconds' }),
	path: z.string().openapi({ example: DESKTOP_STREAM_PATH }),
	password: z.string().openapi({ description: 'VNC password for the noVNC client' }),
})

const accessResponses = {
	400: {
		description: 'agent_id missing or malformed',
		content: { 'application/json': { schema: errorSchema } },
	},
	403: {
		description: "An agent asked for another agent's computer",
		content: { 'application/json': { schema: errorSchema } },
	},
	404: {
		description: 'Desktop not available, or the agent is not in this workspace',
		content: { 'application/json': { schema: errorSchema } },
	},
} as const

const connectRoute = createRoute({
	method: 'post',
	path: '/connect',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Start (if needed) and connect to an agent's computer",
	description:
		"Idempotent. Provisions the agent's desktop on first use, which can take up to a minute, and wakes it if it was suspended for being idle. Returns a one-time ticket to open the WebSocket at `path?ticket=…`.",
	request: { headers: workspaceIdHeader, query: agentQuery },
	responses: {
		200: {
			description: 'Ticket for the desktop stream',
			content: { 'application/json': { schema: connectResponseSchema } },
		},
		...accessResponses,
		503: { description: 'No capacity', content: { 'application/json': { schema: errorSchema } } },
	},
})

const listRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Desktop'],
	summary: 'Which agents in the workspace have a computer, and whether it is asleep',
	description:
		'People see every agent with a computer; an agent sees only its own. Does not wake anything.',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Computers',
			content: {
				'application/json': {
					schema: z.object({
						desktops: z.array(
							z.object({ agent_id: z.string().uuid(), status: z.enum(['running', 'suspended']) }),
						),
					}),
				},
			},
		},
		404: {
			description: 'Desktop not available',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const deleteRoute = createRoute({
	method: 'delete',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Remove an agent's computer",
	request: { headers: workspaceIdHeader, query: agentQuery },
	responses: {
		200: {
			description: 'Removed (or there was none)',
			content: { 'application/json': { schema: z.object({ removed: z.boolean() }) } },
		},
		...accessResponses,
		502: {
			description: 'No agent-server could say where the computer is, so nothing was removed',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

function serviceFor(c: { get: (k: 'desktopService' | 'db') => unknown }): WorkspaceDesktopService {
	return (
		(c.get('desktopService') as WorkspaceDesktopService | undefined) ??
		createWorkspaceDesktopService(c.get('db') as Database)
	)
}

type Ctx = {
	get: (k: 'actorId' | 'actorType' | 'db' | 'desktopService' | 'workspaceRole') => unknown
	header: (name: string, value: string) => void
	req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined }
	json: (body: unknown, status: number) => Response
}

type Gate = { workspaceId: string; actorId: string; agentId: string }

/**
 * The gate every desktop route passes through: the feature flag (a cost, not
 * just a UI branch — starting a desktop provisions a multi-GB microVM), then
 * whose computer this is and whether the caller may reach it.
 *
 * `write` is true for everything except listing ports. Connecting hands out the
 * VNC password, and input/exec/delete act on the machine, so a read-only viewer
 * (a workspace member) must not get through.
 */
async function gate(c: Ctx, { write = true }: { write?: boolean } = {}): Promise<Gate | Response> {
	if (write) assertWorkspaceWriterRole(c.get('workspaceRole') as string | undefined)
	const workspaceId = (c.req.header('x-workspace-id') ?? '').toLowerCase()
	const actorId = c.get('actorId') as string
	const access = await resolveDesktopAgent(c.get('db') as Database, {
		actorId,
		actorType: c.get('actorType') as string | undefined,
		workspaceId,
		requestedAgentId: c.req.query('agent_id'),
	})
	if (!access.ok) {
		const code =
			access.status === 400 ? 'BAD_REQUEST' : access.status === 403 ? 'FORBIDDEN' : 'NOT_FOUND'
		return c.json(createApiError(code, access.message), access.status)
	}
	return { workspaceId, actorId, agentId: access.agentId }
}

const isResponse = (value: Gate | Response): value is Response => value instanceof Response

app.openapi(connectRoute, async (c) => {
	const gated = await gate(c as unknown as Ctx)
	if (isResponse(gated)) return gated as never
	const { workspaceId, actorId, agentId } = gated

	let located: Awaited<ReturnType<WorkspaceDesktopService['ensure']>>
	try {
		located = await serviceFor(c).ensure(workspaceId, agentId)
	} catch (err) {
		logger.error('desktop ensure failed', { workspaceId, agentId, error: String(err) })
		located = null
	}
	if (!located) {
		return c.json(createApiError('INTERNAL_ERROR', 'No desktop could be started'), 503)
	}

	if (located.created) {
		await recordEvent(c.get('db'), {
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'workspace_desktop',
			entityId: workspaceId,
			data: { agent_id: agentId, agent_server_id: located.server.id },
		}).catch((err) => logger.warn('desktop created event failed', { error: String(err) }))
	}

	c.header('Cache-Control', 'no-store')
	return c.json(
		{
			ticket: signDesktopTicket({ workspaceId, actorId, agentId }),
			path: DESKTOP_STREAM_PATH,
			password: located.password,
		},
		200,
	)
})

app.openapi(listRoute, async (c) => {
	const workspaceId = (c.req.header('x-workspace-id') ?? '').toLowerCase()
	const actorId = c.get('actorId')
	let desktops = await serviceFor(c)
		.list(workspaceId)
		.catch((err) => {
			logger.warn('desktop list failed', { workspaceId, error: String(err) })
			return []
		})
	// An agent sees only its own computer, never that there are colleagues' ones.
	if (c.get('actorType') === 'agent') {
		desktops = desktops.filter((d) => d.agentId === actorId.toLowerCase())
	}
	c.header('Cache-Control', 'no-store')
	return c.json({ desktops: desktops.map((d) => ({ agent_id: d.agentId, status: d.status })) }, 200)
})

app.openapi(deleteRoute, async (c) => {
	const gated = await gate(c as unknown as Ctx)
	if (isResponse(gated)) return gated as never
	const { workspaceId, actorId, agentId } = gated
	let removed: boolean
	try {
		removed = await serviceFor(c).remove(workspaceId, agentId)
	} catch (err) {
		logger.error('desktop remove failed', { workspaceId, agentId, error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop could not be reached'), 502)
	}
	if (removed) {
		await recordEvent(c.get('db'), {
			workspaceId,
			actorId,
			action: 'deleted',
			entityType: 'workspace_desktop',
			entityId: workspaceId,
			data: { agent_id: agentId },
		}).catch((err) => logger.warn('desktop deleted event failed', { error: String(err) }))
	}
	return c.json({ removed }, 200)
})

// Agent control. Same flag + access boundary as /connect: agents call these
// through the Maskin MCP with their API key, so the desktop is shared with the
// humans who are watching it over /stream and can take over at any time.

const controlResponses = {
	...accessResponses,
	502: {
		description: 'Desktop could not be reached',
		content: { 'application/json': { schema: errorSchema } },
	},
} as const

const screenshotRoute = createRoute({
	method: 'post',
	path: '/screenshot',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Screenshot of an agent's desktop",
	description: 'Starts the desktop if needed. Returns a base64 JPEG of the 1280x720 screen.',
	request: { headers: workspaceIdHeader, query: agentQuery },
	responses: {
		200: {
			description: 'Screenshot',
			content: {
				'application/json': {
					schema: z.object({
						image_base64: z.string(),
						mime_type: z.string(),
						width: z.number(),
						height: z.number(),
					}),
				},
			},
		},
		...controlResponses,
	},
})

const inputRoute = createRoute({
	method: 'post',
	path: '/input',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Send mouse/keyboard input to an agent's desktop",
	request: {
		headers: workspaceIdHeader,
		query: agentQuery,
		body: { content: { 'application/json': { schema: desktopInputActionSchema } } },
	},
	responses: {
		200: {
			description: 'Input delivered',
			content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
		},
		...controlResponses,
	},
})

const execRoute = createRoute({
	method: 'post',
	path: '/exec',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Run a shell command inside an agent's desktop VM",
	request: {
		headers: workspaceIdHeader,
		query: agentQuery,
		body: { content: { 'application/json': { schema: desktopExecBodySchema } } },
	},
	responses: {
		200: {
			description: 'Command result',
			content: { 'application/json': { schema: desktopExecResultSchema } },
		},
		...controlResponses,
	},
})

type ControlAction = 'screenshot' | 'input' | 'exec'

/**
 * The session a call comes from, so a credential allowed for only this chat counts. Taken
 * only when it is this actor's own session in this workspace; anything else is ignored.
 */
async function ownSession(
	db: Database,
	header: string | undefined,
	workspaceId: string,
	actorId: string,
): Promise<{ sessionId?: string; conversationId?: string | null }> {
	if (!header || !z.string().uuid().safeParse(header).success) return {}
	const [row] = await db
		.select({ id: sessions.id, conversationId: sessions.conversationId })
		.from(sessions)
		.where(
			and(
				eq(sessions.id, header),
				eq(sessions.workspaceId, workspaceId),
				eq(sessions.actorId, actorId),
			),
		)
		.limit(1)
	return row ? { sessionId: row.id, conversationId: row.conversationId } : {}
}

async function forwardControl(c: Ctx, action: ControlAction, body: unknown) {
	const gated = await gate(c)
	if (isResponse(gated)) return gated
	const { workspaceId, actorId, agentId } = gated

	// A saved login typed by reference: swap the real value in here, after the grant check,
	// so the agent never holds it. `forwarded` is what reaches the computer; `body` (what the
	// agent sent) is all that is ever logged.
	let forwarded = body
	let typedCredential: { credentialName: string; field: string } | null = null
	const typing = body as { action?: string; text?: string }
	if (action === 'input' && typing.action === 'type' && typeof typing.text === 'string') {
		const db = c.get('db') as Database
		const resolved = await resolveKeychainTyping(
			db,
			{
				workspaceId,
				actorId,
				actorType: c.get('actorType') as string | undefined,
				...(await ownSession(db, c.req.header('x-maskin-session-id'), workspaceId, actorId)),
			},
			typing.text,
		)
		if (resolved.kind === 'error') {
			const code =
				resolved.status === 400
					? 'BAD_REQUEST'
					: resolved.status === 403
						? 'FORBIDDEN'
						: 'NOT_FOUND'
			return c.json(createApiError(code, resolved.message), resolved.status)
		}
		if (resolved.kind === 'resolved') {
			forwarded = { ...(body as object), text: resolved.text }
			typedCredential = { credentialName: resolved.credentialName, field: resolved.field }
		}
	}

	let result: Awaited<ReturnType<WorkspaceDesktopService['control']>>
	try {
		result = await serviceFor(c).control(workspaceId, agentId, action, forwarded)
	} catch (err) {
		logger.error('desktop control failed', { workspaceId, agentId, action, error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop could not be reached'), 502)
	}
	if (!result) return c.json(createApiError('NOT_FOUND', 'No desktop could be started'), 404)

	// Screenshots are reads; input and exec change the desktop everyone is watching.
	if (action !== 'screenshot' && result.status === 200) {
		await recordEvent(c.get('db') as Database, {
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'workspace_desktop',
			entityId: workspaceId,
			// Deliberately not the typed text or command: those can hold secrets.
			data: {
				agent_id: agentId,
				control: action,
				...(action === 'input' ? { input_action: (body as { action: string }).action } : {}),
				// The credential's name and which part, never its value.
				...(typedCredential
					? {
							keychain_credential: typedCredential.credentialName,
							keychain_field: typedCredential.field,
						}
					: {}),
			},
		}).catch((err) => logger.warn('desktop control event failed', { error: String(err) }))
	}
	c.header('Cache-Control', 'no-store')
	// The desktop received the real value. Whatever it says back about a failed call could
	// quote it, so the agent gets a fixed message, never the downstream body.
	if (typedCredential && result.status !== 200) {
		logger.warn('desktop refused a typed saved login', {
			workspaceId,
			agentId,
			status: result.status,
		})
		return c.json(
			createApiError(
				'INTERNAL_ERROR',
				'The computer could not type the saved login. Nothing was shown.',
			),
			502,
		)
	}
	return c.json(result.body, result.status)
}

app.openapi(screenshotRoute, (c) => forwardControl(c as unknown as Ctx, 'screenshot', {}) as never)
app.openapi(
	inputRoute,
	(c) => forwardControl(c as unknown as Ctx, 'input', c.req.valid('json')) as never,
)
app.openapi(
	execRoute,
	(c) => forwardControl(c as unknown as Ctx, 'exec', c.req.valid('json')) as never,
)

// Dev servers an agent's computer can open. The agent starts a server in its own
// session sandbox and asks for a URL its computer's browser can use. The relay
// port comes from the computer's own block on the agent-server; the caller never
// names a host port.

const portSchema = z.object({
	guest_port: z.number().int(),
	relay_port: z.number().int(),
	url: z.string().openapi({ example: 'http://host.microsandbox.internal:20003' }),
})

const exposePortRoute = createRoute({
	method: 'post',
	path: '/ports',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: "Open a port in the agent's session sandbox from its computer",
	description:
		"Idempotent per (session, port). Returns a URL the computer's browser can open. The session must be the agent's own and running on the same server as its computer.",
	request: {
		headers: workspaceIdHeader,
		query: agentQuery,
		body: {
			content: {
				'application/json': {
					schema: z.object({
						session_id: z.string().uuid(),
						guest_port: z.number().int().min(1).max(65535),
					}),
				},
			},
		},
	},
	responses: {
		200: { description: 'Exposed', content: { 'application/json': { schema: portSchema } } },
		...controlResponses,
		503: {
			description: 'No desktop could be started',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Session not running here, no free port, or the computer cannot be given one',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const listPortsRoute = createRoute({
	method: 'get',
	path: '/ports',
	tags: ['Desktop'],
	summary: "Ports currently open from the agent's computer",
	request: { headers: workspaceIdHeader, query: agentQuery },
	responses: {
		200: {
			description: 'Open ports',
			content: {
				'application/json': {
					schema: z.object({ ports: z.array(portSchema.extend({ session_id: z.string() })) }),
				},
			},
		},
		...controlResponses,
	},
})

const closePortRoute = createRoute({
	method: 'delete',
	path: '/ports/{relay_port}',
	'x-viewer-policy': 'writer',
	tags: ['Desktop'],
	summary: 'Close an open port to free a slot',
	request: {
		headers: workspaceIdHeader,
		query: agentQuery,
		params: z.object({ relay_port: z.coerce.number().int().min(1).max(65535) }),
	},
	responses: {
		200: {
			description: 'Closed (or it was not open)',
			content: { 'application/json': { schema: z.object({ closed: z.boolean() }) } },
		},
		...controlResponses,
	},
})

const LIVE_SESSION_STATUSES = new Set(['starting', 'running', 'waiting_for_input'])

async function exposePort(c: Ctx, input: { sessionId: string; guestPort: number }) {
	const gated = await gate(c)
	if (isResponse(gated)) return gated
	const { workspaceId, actorId, agentId } = gated
	const { sessionId, guestPort } = input
	const db = c.get('db') as Database

	const [session] = await db
		.select({
			id: sessions.id,
			actorId: sessions.actorId,
			workspaceId: sessions.workspaceId,
			status: sessions.status,
			agentServerId: sessions.agentServerId,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1)
	// Same answer for "not yours" and "does not exist": a session id proves nothing.
	if (!session || session.workspaceId !== workspaceId || session.actorId !== agentId) {
		return c.json(createApiError('NOT_FOUND', 'No such session for this agent'), 404)
	}
	if (!LIVE_SESSION_STATUSES.has(session.status)) {
		return c.json(createApiError('CONFLICT', 'That session is not running any more'), 409)
	}
	if (!session.agentServerId) {
		return c.json(
			createApiError(
				'CONFLICT',
				'This session does not run on an agent-server, so its computer cannot reach it',
			),
			409,
		)
	}

	const service = serviceFor(c as never)
	let located: Awaited<ReturnType<WorkspaceDesktopService['ensure']>>
	try {
		located = await service.ensure(workspaceId, agentId, { preferServerId: session.agentServerId })
	} catch (err) {
		logger.error('desktop ensure failed', { workspaceId, agentId, error: String(err) })
		located = null
	}
	if (!located) return c.json(createApiError('INTERNAL_ERROR', 'No desktop could be started'), 503)
	if (located.server.id !== session.agentServerId) {
		return c.json(
			createApiError(
				'CONFLICT',
				"This agent's computer runs on a different server than this session, and a computer can only reach sessions on its own server. Start a new session to get one on the same server, or remove the computer so it is recreated next to this session.",
			),
			409,
		)
	}

	let result: Awaited<ReturnType<WorkspaceDesktopService['ports']>>
	try {
		result = await service.ports(located.server, workspaceId, agentId, {
			type: 'expose',
			sessionId,
			guestPort,
		})
	} catch (err) {
		logger.error('desktop expose port failed', { workspaceId, agentId, error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop could not be reached'), 502)
	}
	if (result.status === 200) {
		await recordEvent(db, {
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'workspace_desktop',
			entityId: workspaceId,
			data: { agent_id: agentId, control: 'expose_port', guest_port: guestPort },
		}).catch((err) => logger.warn('desktop expose event failed', { error: String(err) }))
	}
	c.header('Cache-Control', 'no-store')
	return c.json(result.body, result.status)
}

app.openapi(
	exposePortRoute,
	(c) =>
		exposePort(c as unknown as Ctx, {
			sessionId: c.req.valid('json').session_id,
			guestPort: c.req.valid('json').guest_port,
		}) as never,
)

async function forwardPorts(
	c: Ctx,
	action: { type: 'list' } | { type: 'close'; relayPort: number },
) {
	const gated = await gate(c, { write: action.type !== 'list' })
	if (isResponse(gated)) return gated
	const { workspaceId, agentId } = gated
	const service = serviceFor(c as never)
	const located = await service.locate(workspaceId, agentId)
	if (!located) {
		// No computer yet means nothing is open; listing must not start one.
		return action.type === 'list' ? c.json({ ports: [] }, 200) : c.json({ closed: false }, 200)
	}
	try {
		const result = await service.ports(located.server, workspaceId, agentId, action)
		c.header('Cache-Control', 'no-store')
		return c.json(result.body, result.status)
	} catch (err) {
		logger.error('desktop ports failed', { workspaceId, agentId, error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Desktop could not be reached'), 502)
	}
}

app.openapi(listPortsRoute, (c) => forwardPorts(c as unknown as Ctx, { type: 'list' }) as never)
app.openapi(
	closePortRoute,
	(c) =>
		forwardPorts(c as unknown as Ctx, {
			type: 'close',
			relayPort: c.req.valid('param').relay_port,
		}) as never,
)

export default app
