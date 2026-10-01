import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
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

export default app
