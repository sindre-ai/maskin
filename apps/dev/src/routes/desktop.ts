import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	desktopExecBodySchema,
	desktopExecResultSchema,
	desktopInputActionSchema,
} from '@maskin/shared'
import { resolveDesktopAgent } from '../lib/desktop-access'
import { signDesktopTicket } from '../lib/desktop-ticket'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { FLAGS, isFlagEnabledForWorkspace } from '../lib/feature-flags'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
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
	tags: ['Desktop'],
	summary: "Remove an agent's computer",
	request: { headers: workspaceIdHeader, query: agentQuery },
	responses: {
		200: {
			description: 'Removed (or there was none)',
			content: { 'application/json': { schema: z.object({ removed: z.boolean() }) } },
		},
		...accessResponses,
	},
})

function serviceFor(c: { get: (k: 'desktopService' | 'db') => unknown }): WorkspaceDesktopService {
	return (
		(c.get('desktopService') as WorkspaceDesktopService | undefined) ??
		createWorkspaceDesktopService(c.get('db') as Database)
	)
}

type Ctx = {
	get: (k: 'actorId' | 'actorType' | 'db' | 'desktopService') => unknown
	header: (name: string, value: string) => void
	req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined }
	json: (body: unknown, status: number) => Response
}

type Gate = { workspaceId: string; actorId: string; agentId: string }

/**
 * The gate every desktop route passes through: the feature flag (a cost, not
 * just a UI branch — starting a desktop provisions a multi-GB microVM), then
 * whose computer this is and whether the caller may reach it.
 */
async function gate(c: Ctx): Promise<Gate | Response> {
	const workspaceId = (c.req.header('x-workspace-id') ?? '').toLowerCase()
	const actorId = c.get('actorId') as string
	if (!isFlagEnabledForWorkspace(workspaceId, FLAGS.WORKSPACE_DESKTOP, { actorId })) {
		return c.json(createApiError('NOT_FOUND', 'Desktop is not available'), 404)
	}
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
	if (!isFlagEnabledForWorkspace(workspaceId, FLAGS.WORKSPACE_DESKTOP, { actorId })) {
		return c.json(createApiError('NOT_FOUND', 'Desktop is not available'), 404)
	}
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
	const removed = await serviceFor(c).remove(workspaceId, agentId)
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

async function forwardControl(c: Ctx, action: ControlAction, body: unknown) {
	const gated = await gate(c)
	if (isResponse(gated)) return gated
	const { workspaceId, actorId, agentId } = gated

	let result: Awaited<ReturnType<WorkspaceDesktopService['control']>>
	try {
		result = await serviceFor(c).control(workspaceId, agentId, action, body)
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
			},
		}).catch((err) => logger.warn('desktop control event failed', { error: String(err) }))
	}
	c.header('Cache-Control', 'no-store')
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

export default app
