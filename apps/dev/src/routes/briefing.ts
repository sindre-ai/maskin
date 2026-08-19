import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import type { StorageProvider } from '@maskin/storage'
import { validationFailureHook } from '../lib/errors'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { generateSpokenBrief } from '../services/spoken-brief'
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

const spokenBriefResponseSchema = z.object({
	workspace_id: z.string().uuid(),
	/** The first sentence — the script is prose, so it titles itself. */
	headline: z.string(),
	/** Plain spoken prose. No markdown, no ids, nothing to strip. */
	script: z.string(),
	mentioned_ids: z.array(z.string().uuid()),
	generated_at: z.string(),
	source: z.enum(['cache', 'agent', 'fallback']),
	agent: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
	model: z.string().nullable(),
})

const spokenBriefRoute = createRoute({
	method: 'post',
	path: '/spoken',
	tags: ['Briefing'],
	summary: "Generate today's brief as spoken prose",
	description:
		"The human-facing brief: the workspace's default agent (its Chief of Staff) writing the same facts as something to listen to, rather than the agent-facing markdown `GET /briefing` returns.\n\nPOST because it generates — one small model call, on demand, only when someone asks to hear it. The result is cached for the rest of the UTC day under a fingerprint of the workspace state, so asking again costs nothing unless something actually changed. Falls back to deterministic prose when the workspace has no chat-callable credentials, so this never fails for want of a model.",
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'The spoken brief',
			content: { 'application/json': { schema: spokenBriefResponseSchema } },
		},
		400: {
			description: 'Invalid workspace id',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(spokenBriefRoute, async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const brief = await generateSpokenBrief(db, storage, workspaceId)
	return c.json(
		{
			workspace_id: brief.workspaceId,
			headline: brief.headline,
			script: brief.script,
			mentioned_ids: brief.mentionedIds,
			generated_at: brief.generatedAt,
			source: brief.source,
			agent: brief.agent,
			model: brief.model,
		},
		200,
	)
})

export default app
