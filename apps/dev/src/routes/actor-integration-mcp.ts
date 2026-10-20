import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import {
	agentsThatLostPreset,
	presetAttached,
	resolveMcpPresets,
	serversOf,
} from '../lib/integrations/mcp-presets'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const approveRoute = createRoute({
	method: 'post',
	path: '/{id}/integration-mcp/{presetId}',
	'x-viewer-policy': 'writer',
	tags: ['Actors'],
	summary: "Approve attaching an integration's MCP entry to an agent",
	description:
		'The click behind the Approve card an agent raises with propose_integration_attach. ' +
		"Needs a human workspace admin or owner. The entry is re-derived here from the workspace's ACTIVE integrations, " +
		'so the request carries no tools and a click can never write anything but a real preset. ' +
		'all_affected also attaches it to every agent a disconnect stripped it from.',
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid(), presetId: z.string().min(1).max(200) }),
		body: {
			required: false,
			content: {
				'application/json': { schema: z.object({ all_affected: z.boolean().optional() }) },
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						preset_id: z.string(),
						key: z.string(),
						attached_actor_ids: z.array(z.string().uuid()),
						already_attached_actor_ids: z.array(z.string().uuid()),
					}),
				},
			},
			description: 'Entry written to each agent that did not hold it',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller is not a human workspace admin or owner',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Agent not in this workspace, or no active integration offers this preset',
		},
	},
})

app.openapi(approveRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { id, presetId } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json') ?? {}

	// A person's click, never an agent's call: the whole point of the card is
	// that an agent can ask for tools but not grant them to itself or a peer.
	if (c.get('actorType') !== 'human') {
		return c.json(createApiError('FORBIDDEN', 'Only a human can approve attaching tools'), 403)
	}
	const [membership] = await db
		.select({ role: workspaceMembers.role })
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, callerId)),
		)
		.limit(1)
	if (!membership || !['owner', 'admin'].includes(membership.role)) {
		return c.json(
			createApiError('FORBIDDEN', 'Only a workspace admin or owner can attach tools to an agent'),
			403,
		)
	}

	const [target] = await db
		.select({ id: actors.id, tools: actors.tools })
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(actors.id, id),
				eq(actors.type, 'agent'),
				eq(workspaceMembers.workspaceId, workspaceId),
			),
		)
		.limit(1)
	if (!target) return c.json(createApiError('NOT_FOUND', 'Agent not found in this workspace'), 404)

	const preset = (await resolveMcpPresets(db, workspaceId)).find((p) => p.preset_id === presetId)
	if (!preset) {
		return c.json(
			createApiError('NOT_FOUND', 'No active integration in this workspace offers that preset'),
			404,
		)
	}

	const targets = [{ id: target.id, name: '' }]
	if (body.all_affected) {
		for (const agent of await agentsThatLostPreset(db, workspaceId, preset)) {
			if (agent.id !== target.id) targets.push(agent)
		}
	}

	const attached: string[] = []
	const already: string[] = []
	for (const { id: agentId } of targets) {
		await db.transaction(async (tx) => {
			// Read inside the transaction so two approvals racing cannot lose a write.
			const [row] = await tx
				.select({ tools: actors.tools })
				.from(actors)
				.where(eq(actors.id, agentId))
				.for('update')
			const tools = (row?.tools ?? {}) as Record<string, unknown>
			if (presetAttached(preset, tools)) {
				already.push(agentId)
				return
			}
			await tx
				.update(actors)
				.set({
					tools: { ...tools, mcpServers: { ...serversOf(tools), [preset.key]: preset.server } },
					updatedAt: new Date(),
				})
				.where(eq(actors.id, agentId))
			await recordEvent(tx, {
				workspaceId,
				actorId: callerId,
				action: 'updated',
				entityType: 'actor',
				entityId: agentId,
				data: {
					mcp_servers_attached: [preset.key],
					reason: 'integration_attach_approved',
					provider: preset.provider,
					preset_id: preset.preset_id,
				},
			})
			attached.push(agentId)
		})
	}

	logger.info('Attached integration MCP entry to agent after approval', {
		workspaceId,
		presetId: preset.preset_id,
		approvedBy: callerId,
		attached,
		already,
	})
	return c.json({
		preset_id: preset.preset_id,
		key: preset.key,
		attached_actor_ids: attached,
		already_attached_actor_ids: already,
	})
}) as RouteHandler<typeof approveRoute, Env>)

export default app
