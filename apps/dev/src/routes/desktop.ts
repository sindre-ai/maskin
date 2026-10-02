import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	desktopExecBodySchema,
	desktopExecResultSchema,
	desktopInputActionSchema,
} from '@maskin/shared'
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

// Workspace-scoped via X-Workspace-Id: authMiddleware has already confirmed the
// caller is a member of that workspace before these handlers run.
type Env = {
	Variables: {
		db: Database
		actorId: string
		// Test seam: unit tests inject a fake instead of hitting agent-servers.
		desktopService?: WorkspaceDesktopService
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const connectResponseSchema = z.object({
	ticket: z.string().openapi({ description: 'One-time ticket, valid for 30 seconds' }),
	path: z.string().openapi({ example: DESKTOP_STREAM_PATH }),
	password: z.string().openapi({ description: 'VNC password for the noVNC client' }),
})

const connectRoute = createRoute({
	method: 'post',
	path: '/connect',
	tags: ['Desktop'],
	summary: "Start (if needed) and connect to the workspace's desktop",
	description:
		'Idempotent. Provisions the workspace desktop on first use, which can take up to a minute. Returns a one-time ticket to open the WebSocket at `path?ticket=…`.',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Ticket for the desktop stream',
			content: { 'application/json': { schema: connectResponseSchema } },
		},
		404: {
			description: 'Desktop not available',
			content: { 'application/json': { schema: errorSchema } },
		},
		503: { description: 'No capacity', content: { 'application/json': { schema: errorSchema } } },
	},
})

const deleteRoute = createRoute({
	method: 'delete',
	path: '/',
	tags: ['Desktop'],
	summary: "Remove the workspace's desktop",
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Removed (or there was none)',
			content: { 'application/json': { schema: z.object({ removed: z.boolean() }) } },
		},
		404: {
			description: 'Desktop not available',
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

app.openapi(connectRoute, async (c) => {
	const workspaceId = c.req.valid('header')['x-workspace-id'].toLowerCase()
	const actorId = c.get('actorId')
	if (!isFlagEnabledForWorkspace(workspaceId, FLAGS.WORKSPACE_DESKTOP, { actorId })) {
		return c.json(createApiError('NOT_FOUND', 'Desktop is not available'), 404)
	}

	let located: Awaited<ReturnType<WorkspaceDesktopService['ensure']>>
	try {
		located = await serviceFor(c).ensure(workspaceId)
	} catch (err) {
		logger.error('desktop ensure failed', { workspaceId, error: String(err) })
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
			data: { agent_server_id: located.server.id },
		}).catch((err) => logger.warn('desktop created event failed', { error: String(err) }))
	}

	c.header('Cache-Control', 'no-store')
	return c.json(
		{
			ticket: signDesktopTicket({ workspaceId, actorId }),
			path: DESKTOP_STREAM_PATH,
			password: located.password,
		},
		200,
	)
})

app.openapi(deleteRoute, async (c) => {
	const workspaceId = c.req.valid('header')['x-workspace-id'].toLowerCase()
	const actorId = c.get('actorId')
	if (!isFlagEnabledForWorkspace(workspaceId, FLAGS.WORKSPACE_DESKTOP, { actorId })) {
		return c.json(createApiError('NOT_FOUND', 'Desktop is not available'), 404)
	}
	const removed = await serviceFor(c).remove(workspaceId)
	if (removed) {
		await recordEvent(c.get('db'), {
			workspaceId,
			actorId,
			action: 'deleted',
			entityType: 'workspace_desktop',
			entityId: workspaceId,
		}).catch((err) => logger.warn('desktop deleted event failed', { error: String(err) }))
	}
	return c.json({ removed }, 200)
})

// Agent control. Same flag + membership boundary as /connect: agents call these
// through the Maskin MCP with their API key, so the desktop is shared with the
// humans who are watching it over /stream and can take over at any time.

const controlResponses = {
	404: {
		description: 'Desktop not available',
		content: { 'application/json': { schema: errorSchema } },
	},
	502: {
		description: 'Desktop could not be reached',
		content: { 'application/json': { schema: errorSchema } },
	},
} as const

const screenshotRoute = createRoute({
	method: 'post',
	path: '/screenshot',
	tags: ['Desktop'],
	summary: "Screenshot of the workspace's desktop",
	description: 'Starts the desktop if needed. Returns a base64 JPEG of the 1280x720 screen.',
	request: { headers: workspaceIdHeader },
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
	summary: "Send mouse/keyboard input to the workspace's desktop",
	request: {
		headers: workspaceIdHeader,
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
	summary: "Run a shell command inside the workspace's desktop VM",
	request: {
		headers: workspaceIdHeader,
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

async function forwardControl(
	c: {
		get: (k: 'actorId' | 'db' | 'desktopService') => unknown
		header: (name: string, value: string) => void
		req: { header: (name: string) => string | undefined }
		json: (body: unknown, status: number) => Response
	},
	action: ControlAction,
	body: unknown,
) {
	const workspaceId = (c.req.header('x-workspace-id') ?? '').toLowerCase()
	const actorId = c.get('actorId') as string
	if (!isFlagEnabledForWorkspace(workspaceId, FLAGS.WORKSPACE_DESKTOP, { actorId })) {
		return c.json(createApiError('NOT_FOUND', 'Desktop is not available'), 404)
	}
	let result: Awaited<ReturnType<WorkspaceDesktopService['control']>>
	try {
		result = await serviceFor(c).control(workspaceId, action, body)
	} catch (err) {
		logger.error('desktop control failed', { workspaceId, action, error: String(err) })
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
				control: action,
				...(action === 'input' ? { input_action: (body as { action: string }).action } : {}),
			},
		}).catch((err) => logger.warn('desktop control event failed', { error: String(err) }))
	}
	c.header('Cache-Control', 'no-store')
	return c.json(result.body, result.status)
}

app.openapi(screenshotRoute, (c) => forwardControl(c, 'screenshot', {}) as never)
app.openapi(inputRoute, (c) => forwardControl(c, 'input', c.req.valid('json')) as never)
app.openapi(execRoute, (c) => forwardControl(c, 'exec', c.req.valid('json')) as never)

export default app
