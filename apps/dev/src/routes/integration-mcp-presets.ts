import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import {
	agentsThatLostPreset,
	presetAttached,
	resolveMcpPresets,
	staleEntriesOf,
	toPublicPreset,
} from '../lib/integrations/mcp-presets'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

type Env = { Variables: { db: Database; actorId: string } }

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const presetSchema = z.object({
	preset_id: z.string(),
	provider: z.string(),
	provider_label: z.string(),
	label: z.string(),
	integration_id: z.string().uuid(),
	key: z.string(),
	auto_injected: z.boolean(),
	server: z.record(z.unknown()),
	attached: z.boolean().optional(),
	affected_agents: z.array(z.object({ id: z.string().uuid(), name: z.string() })).optional(),
})

const responseSchema = z.object({
	presets: z.array(presetSchema),
	drift: z
		.object({
			actor_id: z.string().uuid(),
			missing_preset_ids: z.array(z.string()),
			stale_entries: z.array(z.object({ key: z.string(), provider: z.string() })),
		})
		.optional(),
})

const listPresetsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['integrations'],
	summary: 'List the MCP entries the workspace can attach to an agent',
	description:
		"Derived from each provider config plus the workspace's ACTIVE integrations and live identities. " +
		'With actor_id, each preset says whether that agent already holds it and `drift` lists what is missing or points at a revoked connection. ' +
		'With include=affected, each preset lists the agents a disconnect stripped it from. Read-only: attaching goes through propose_integration_attach and the approve route.',
	request: {
		headers: workspaceIdHeader,
		query: z.object({
			actor_id: z.string().uuid().optional(),
			include: z.enum(['affected']).optional(),
		}),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: responseSchema } },
			description: 'Attachable presets',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'actor_id is not an agent in this workspace',
		},
	},
})

app.openapi(listPresetsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { actor_id: actorId, include } = c.req.valid('query')

	let tools: unknown
	if (actorId) {
		const [agent] = await db
			.select({ tools: actors.tools })
			.from(actors)
			.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
			.where(
				and(
					eq(actors.id, actorId),
					eq(actors.type, 'agent'),
					eq(workspaceMembers.workspaceId, workspaceId),
				),
			)
			.limit(1)
		if (!agent) return c.json(createApiError('NOT_FOUND', 'Agent not found in this workspace'), 404)
		tools = agent.tools
	}

	const resolved = await resolveMcpPresets(db, workspaceId)
	const presets = await Promise.all(
		resolved.map(async (preset) => ({
			...toPublicPreset(preset),
			...(actorId && { attached: presetAttached(preset, tools) }),
			...(include === 'affected' && {
				affected_agents: await agentsThatLostPreset(db, workspaceId, preset),
			}),
		})),
	)

	return c.json({
		presets,
		...(actorId && {
			drift: {
				actor_id: actorId,
				// Providers that session-manager wires in on its own are not "missing".
				missing_preset_ids: presets
					.filter((p) => !p.attached && !p.auto_injected)
					.map((p) => p.preset_id),
				stale_entries: await staleEntriesOf(db, workspaceId, tools),
			},
		}),
	} as z.infer<typeof responseSchema>)
}) as RouteHandler<typeof listPresetsRoute, Env>)

export default app
