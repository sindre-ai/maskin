import type { Database } from '@maskin/db'
import { actors, sendPermissions, workspaceMembers } from '@maskin/db/schema'
import {
	SEND_PERMISSION_KINDS,
	SEND_PERMISSION_MODES,
	type SendPermissionKind,
	type SendPermissionMode,
} from '@maskin/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { CLIENT_SOURCE_HEADER } from '../lib/analytics/knowledge-events'
import { createApiError } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { type SendModeSource, startingSendMode } from '../lib/send-permissions'
import { isWorkspaceHumanAdminOrOwner } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new Hono<Env>()

interface EffectiveSetting {
	mode: SendPermissionMode
	source: SendModeSource
}

/**
 * GET /api/send-permissions
 *
 * Every send setting in the workspace, resolved the way the send gate resolves it: the
 * workspace default per kind, and for every agent the mode in force per kind with where it came
 * from (its own setting, the workspace default, or the starting table). Any member can read it.
 */
app.get('/', async (c) => {
	const db = c.get('db')
	const workspaceId = c.req.header('x-workspace-id')
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'Missing X-Workspace-Id header'), 400)
	}

	const [rows, agents] = await Promise.all([
		db.select().from(sendPermissions).where(eq(sendPermissions.workspaceId, workspaceId)),
		db
			.select({ id: actors.id, name: actors.name })
			.from(workspaceMembers)
			.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.type, 'agent')))
			.orderBy(actors.name),
	])

	const defaults = {} as Record<SendPermissionKind, EffectiveSetting>
	for (const kind of SEND_PERMISSION_KINDS) {
		const row = rows.find((r) => r.agentId === null && r.kind === kind)
		defaults[kind] = row
			? { mode: row.mode, source: 'workspace' }
			: { mode: startingSendMode(kind), source: 'starting' }
	}

	return c.json({
		kinds: SEND_PERMISSION_KINDS,
		modes: SEND_PERMISSION_MODES,
		workspace_default: defaults,
		agents: agents.map((agent) => {
			const settings = {} as Record<SendPermissionKind, EffectiveSetting>
			for (const kind of SEND_PERMISSION_KINDS) {
				const own = rows.find((r) => r.agentId === agent.id && r.kind === kind)
				settings[kind] = own ? { mode: own.mode, source: 'agent' } : defaults[kind]
			}
			return { agent_id: agent.id, name: agent.name, settings }
		}),
	})
})

const putSchema = z.object({
	/** The agent the setting is for, or null for the workspace default. */
	agent_id: z.string().uuid().nullable(),
	kind: z.enum(SEND_PERMISSION_KINDS),
	/** Null removes an agent's own setting, so the workspace default applies again. */
	mode: z.enum(SEND_PERMISSION_MODES).nullable(),
})

/**
 * PUT /api/send-permissions
 *
 * Sets one send setting: always_allow, ask_first or deny for an agent and a draft kind, or for
 * the workspace default when agent_id is null. mode null removes an agent's own setting (the
 * workspace default applies again); the workspace default itself cannot be removed, only changed.
 *
 * Human admins and owners only. An agent is refused whatever its role, because an agent that
 * could write this could allow its own sends. A call that carries X-Client-Source: mcp is
 * refused too, since there a model holds the person's key; no MCP tool is built on this route.
 * Plain Hono, not createRoute, so the OpenAPI snapshot behind the Apple client does not change.
 */
app.put('/', async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('x-workspace-id')
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'Missing X-Workspace-Id header'), 400)
	}

	if (
		c.req.header(CLIENT_SOURCE_HEADER) === 'mcp' ||
		!(await isWorkspaceHumanAdminOrOwner(db, actorId, workspaceId))
	) {
		return c.json(
			createApiError(
				'FORBIDDEN',
				'Only a human admin or owner can change send permissions, from the app',
			),
			403,
		)
	}

	let raw: unknown
	try {
		raw = await c.req.json()
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON in request body'), 400)
	}
	const parsed = putSchema.safeParse(raw)
	if (!parsed.success) {
		return c.json(
			createApiError(
				'VALIDATION_ERROR',
				`Expected agent_id (an agent id, or null for the workspace default), kind (one of ${SEND_PERMISSION_KINDS.join(', ')}) and mode (one of ${SEND_PERMISSION_MODES.join(', ')}, or null to remove an agent's own setting)`,
			),
			400,
		)
	}
	const { agent_id: agentId, kind, mode } = parsed.data

	if (agentId === null && mode === null) {
		return c.json(
			createApiError('VALIDATION_ERROR', 'The workspace default can be changed but not removed'),
			400,
		)
	}
	if (agentId !== null) {
		const [agent] = await db
			.select({ id: actors.id })
			.from(workspaceMembers)
			.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					eq(workspaceMembers.actorId, agentId),
					eq(actors.type, 'agent'),
				),
			)
			.limit(1)
		if (!agent) {
			return c.json(createApiError('NOT_FOUND', 'That agent is not in this workspace'), 404)
		}
	}

	const scope = and(
		eq(sendPermissions.workspaceId, workspaceId),
		eq(sendPermissions.kind, kind),
		agentId === null ? isNull(sendPermissions.agentId) : eq(sendPermissions.agentId, agentId),
	)

	const previousMode = await db.transaction(async (tx) => {
		const [existing] = await tx.select().from(sendPermissions).where(scope).limit(1)

		if (mode === null) {
			if (existing) await tx.delete(sendPermissions).where(eq(sendPermissions.id, existing.id))
		} else if (existing) {
			await tx
				.update(sendPermissions)
				.set({ mode, updatedBy: actorId, updatedAt: new Date() })
				.where(eq(sendPermissions.id, existing.id))
		} else {
			await tx
				.insert(sendPermissions)
				.values({ workspaceId, agentId, kind, mode, updatedBy: actorId })
		}

		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: 'send_permission_updated',
			entityType: 'workspace',
			entityId: workspaceId,
			data: { agent_id: agentId, kind, before: existing?.mode ?? null, after: mode },
		})
		return existing?.mode ?? null
	})

	return c.json({ agent_id: agentId, kind, mode, previous_mode: previousMode })
})

export default app
