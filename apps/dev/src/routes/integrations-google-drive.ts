import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { createApiError, validationFailureHook } from '../lib/errors'
import {
	listDriveWatches,
	stopDriveWatch,
} from '../lib/integrations/providers/google-drive/watched-folders'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

/**
 * Google Drive folder watches, as shown in the Folder watches section of the
 * Drive detail page: read the list and stop one. Creating a watch stays with the
 * agent tool (google_drive__watch_folder). Mounted at /api/integrations/google-drive,
 * ahead of the generic /api/integrations catch-all, like the MCP subtree beside it.
 *
 * Workspace scoping: the auth middleware has already verified the caller is a
 * member of X-Workspace-Id, and every query below is keyed on that header's
 * workspace, so a folder id from another workspace never matches.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const driveWatchSchema = z.object({
	folderId: z.string(),
	name: z.string(),
	path: z.string().nullable(),
	addedAt: z.string().nullable(),
	lastFiredAt: z.string().nullable(),
	integrationId: z.string().uuid(),
	account: z.string().nullable(),
	triggers: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
})

// Drive file and folder ids are URL-safe base64-like strings.
const folderIdParamSchema = z.object({
	folderId: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[A-Za-z0-9_-]+$/),
})

// ── GET /api/integrations/google-drive/watched-folders ───────────────

const listWatchedFoldersRoute = createRoute({
	method: 'get',
	path: '/watched-folders',
	tags: ['integrations'],
	summary: 'List the Drive folders this workspace is watching',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Folder watches across the workspace Drive connections',
			content: { 'application/json': { schema: z.array(driveWatchSchema) } },
		},
	},
})

app.openapi(listWatchedFoldersRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	return c.json(await listDriveWatches(db, workspaceId))
}) as RouteHandler<typeof listWatchedFoldersRoute, Env>)

// ── DELETE /api/integrations/google-drive/watched-folders/:folderId ──

const stopWatchedFolderRoute = createRoute({
	method: 'delete',
	path: '/watched-folders/{folderId}',
	tags: ['integrations'],
	summary: 'Stop watching a Drive folder',
	request: { params: folderIdParamSchema, headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'The watch was removed',
			content: {
				'application/json': { schema: z.object({ ok: z.literal(true), folderId: z.string() }) },
			},
		},
		404: {
			description: 'This workspace is not watching that folder',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(stopWatchedFolderRoute, (async (c) => {
	const db = c.get('db')
	const { folderId } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const stopped = await stopDriveWatch(db, workspaceId, folderId)
	if (stopped === 0) return c.json(createApiError('NOT_FOUND', 'Folder watch not found'), 404)
	return c.json({ ok: true as const, folderId })
}) as RouteHandler<typeof stopWatchedFolderRoute, Env>)

export default app
