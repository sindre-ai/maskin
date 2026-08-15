import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import type { StorageProvider } from '@maskin/storage'
import { validationFailureHook } from '../lib/errors'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { renderWorkspaceBriefing } from '../services/workspace-briefing'

type Env = {
	Variables: {
		db: Database
		actorId: string
		storageProvider: StorageProvider
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const briefingResponseSchema = z.object({
	workspace_id: z.string().uuid(),
	markdown: z.string(),
})

const briefingRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Briefing'],
	summary: 'Get the current workspace briefing as markdown',
	description:
		'Returns the composed workspace briefing (active bets, closed bets, loops, open insights, recent learnings) as a markdown string. Same document agents receive at session start.',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Briefing markdown',
			content: { 'application/json': { schema: briefingResponseSchema } },
		},
		400: {
			description: 'Invalid workspace id',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(briefingRoute, async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const markdown = await renderWorkspaceBriefing(db, storage, workspaceId)
	return c.json({ workspace_id: workspaceId, markdown }, 200)
})

export default app
