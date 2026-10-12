import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, liveSessions, workspaceMembers, workspaces } from '@maskin/db/schema'
import {
	LIVE_PROTOCOL_VERSION,
	createLiveSessionResponseSchema,
	createLiveSessionSchema,
	endLiveSessionResponseSchema,
	endLiveSessionSchema,
	liveSessionResponseSchema,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { trackLiveSessionDenied, trackLiveSessionStarted } from '../lib/analytics/live-events'
import { isEnterprise } from '../lib/enterprise'
import { createApiError, validationFailureHook } from '../lib/errors'
import { FLAGS, isFlagEnabled } from '../lib/feature-flags'
import { liveDailyMinuteCap } from '../lib/live-costs'
import { resolveLiveCredentials } from '../lib/live-credentials'
import { PlanCapExceededError, checkPlanCap } from '../lib/llm-routing'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import type { WorkspaceSettings } from '../lib/types'
import { isWorkspaceMember } from '../lib/workspace-auth'
import {
	LIVE_IDLE_TIMEOUT_MS,
	endLiveSession,
	getLiveMinutesUsedToday,
	secondsUntilLiveCapResets,
} from '../services/live-session-lifecycle'
import { isConversationParticipant } from '../services/spawned-sessions'

type Env = { Variables: { db: Database; actorId: string } }

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const rateLimitedSchema = z
	.object({
		error: z.object({ code: z.literal('RATE_LIMITED'), message: z.string() }),
		retry_after_seconds: z.number(),
	})
	.openapi('LiveSessionRateLimited')

const createBody = createLiveSessionSchema.openapi('CreateLiveSessionBody')
const createResponse = createLiveSessionResponseSchema.openapi('CreateLiveSessionResponse')
const sessionResponse = liveSessionResponseSchema.openapi('LiveSession')
const endBody = endLiveSessionSchema.openapi('EndLiveSessionBody')
const endResponse = endLiveSessionResponseSchema.openapi('EndLiveSessionResponse')

type SessionRow = typeof liveSessions.$inferSelect

export function toLiveSessionResponse(row: SessionRow) {
	return {
		id: row.id,
		status: row.status as z.infer<typeof sessionResponse>['status'],
		workspace_id: row.workspaceId,
		agent_id: row.agentActorId,
		conversation_id: row.conversationId,
		input_mode: row.inputMode as 'text' | 'audio',
		llm_model: row.llmModel,
		tts_model: row.ttsModel,
		tts_voice: row.ttsVoice,
		stt_model: row.sttModel,
		started_at: row.startedAt.toISOString(),
		timeout_at: row.timeoutAt.toISOString(),
	}
}

function liveEnabledFor(metadata: unknown): boolean {
	const live = (metadata as { live?: { enabled?: unknown } } | null)?.live
	return live?.enabled === true
}

// ── Create ───────────────────────────────────────────────────────────

const postRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Live'],
	summary: 'Start a live (voice) session with an agent',
	description:
		'Gated by the **live-mode** feature flag (404 when off). Checks the agent is live-enabled, that the workspace has OpenRouter credentials and plan headroom, and that the caller has no other live call. Returns the WebSocket path to open next.',
	request: { body: { content: { 'application/json': { schema: createBody } }, required: true } },
	responses: {
		201: {
			description: 'Session created',
			content: { 'application/json': { schema: createResponse } },
		},
		400: {
			description: 'Agent is not live-enabled, or X-Workspace-Id is missing',
			content: { 'application/json': { schema: errorSchema } },
		},
		402: {
			description: 'Plan usage cap reached',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Flag off, or agent or conversation not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Already live, or no live-capable credentials',
			content: { 'application/json': { schema: errorSchema } },
		},
		429: {
			description: 'Daily live minutes used',
			content: { 'application/json': { schema: rateLimitedSchema } },
		},
		500: {
			description: 'The call could not be started',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(postRoute, async (c) => {
	const humanId = c.get('actorId')
	const db = c.get('db')
	const body = c.req.valid('json')

	if (!isFlagEnabled(humanId, FLAGS.LIVE_MODE)) {
		await trackLiveSessionDenied(humanId, {
			agent_id: null,
			workspace_id: null,
			reason: 'flag_off',
		})
		return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
	}

	// The workspace comes from X-Workspace-Id (authMiddleware has already proven the caller is a
	// member). The agent must belong to it too.
	const workspaceId = c.req.header('X-Workspace-Id')
	if (!workspaceId) return c.json(createApiError('BAD_REQUEST', 'X-Workspace-Id is required'), 400)

	const [agent] = await db
		.select({
			id: actors.id,
			name: actors.name,
			type: actors.type,
			metadata: actors.metadata,
			llmConfig: actors.llmConfig,
		})
		.from(actors)
		.innerJoin(
			workspaceMembers,
			and(eq(workspaceMembers.actorId, actors.id), eq(workspaceMembers.workspaceId, workspaceId)),
		)
		.where(eq(actors.id, body.agent_id))
		.limit(1)
	if (!agent) {
		await trackLiveSessionDenied(humanId, {
			agent_id: body.agent_id,
			workspace_id: workspaceId,
			reason: 'no_agent',
		})
		return c.json(createApiError('NOT_FOUND', 'Agent not found in this workspace'), 404)
	}
	if (agent.type !== 'agent' || !liveEnabledFor(agent.metadata)) {
		await trackLiveSessionDenied(humanId, {
			agent_id: agent.id,
			workspace_id: workspaceId,
			reason: 'not_live_enabled',
		})
		return c.json(createApiError('BAD_REQUEST', 'This agent is not available for live calls'), 400)
	}

	if (body.conversation_id) {
		const ok = await isConversationParticipant(db, body.conversation_id, humanId)
		if (!ok) return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)
	}

	const [ws] = await db
		.select({
			settings: workspaces.settings,
			enterpriseGranted: workspaces.enterpriseGranted,
			billingOwnerId: workspaces.billingOwnerId,
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!ws) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	const wsSettings = (ws.settings ?? {}) as WorkspaceSettings

	const creds = resolveLiveCredentials({
		wsSettings,
		workspace: ws,
		agent: {
			llmConfig: agent.llmConfig as { model?: string | null } | null,
			metadata: agent.metadata as Record<string, unknown> | null,
		},
	})
	if (!creds) {
		await trackLiveSessionDenied(humanId, {
			agent_id: agent.id,
			workspace_id: workspaceId,
			reason: 'no_credentials',
		})
		return c.json(
			createApiError(
				'CONFLICT',
				'Live calls need an OpenRouter key for this workspace. Add one in Settings.',
			),
			409,
		)
	}

	if (creds.route === 'maskin_plan') {
		try {
			await checkPlanCap({ db, workspaceId, wsSettings, enterprise: isEnterprise(ws) })
		} catch (err) {
			if (err instanceof PlanCapExceededError) {
				await trackLiveSessionDenied(humanId, {
					agent_id: agent.id,
					workspace_id: workspaceId,
					reason: 'plan_cap',
				})
			}
			throw err // app.onError maps PlanCapExceededError to 402
		}
	}

	const minutesUsed = await getLiveMinutesUsedToday(db, workspaceId)
	if (minutesUsed >= liveDailyMinuteCap(wsSettings)) {
		await trackLiveSessionDenied(humanId, {
			agent_id: agent.id,
			workspace_id: workspaceId,
			reason: 'rate_limited',
		})
		return c.json(
			{
				error: {
					code: 'RATE_LIMITED' as const,
					message: 'This workspace has used its live minutes for today',
				},
				retry_after_seconds: secondsUntilLiveCapResets(),
			},
			429,
		)
	}

	let row: SessionRow | undefined
	try {
		;[row] = await db
			.insert(liveSessions)
			.values({
				workspaceId,
				agentActorId: agent.id,
				humanActorId: humanId,
				conversationId: body.conversation_id ?? null,
				status: 'pending',
				inputMode: body.input_mode,
				llmRoute: creds.route,
				llmModel: creds.llmModel,
				ttsModel: creds.ttsModel,
				ttsVoice: creds.ttsVoice,
				sttModel: creds.sttModel,
				timeoutAt: new Date(Date.now() + LIVE_IDLE_TIMEOUT_MS),
			})
			.returning()
	} catch (err) {
		// 23505 on the partial unique index: this person already has a live call.
		if (
			(err as { code?: string; cause?: { code?: string } }).code === '23505' ||
			(err as { cause?: { code?: string } }).cause?.code === '23505'
		) {
			await trackLiveSessionDenied(humanId, {
				agent_id: agent.id,
				workspace_id: workspaceId,
				reason: 'concurrent',
			})
			return c.json(createApiError('CONFLICT', 'You already have a live call'), 409)
		}
		throw err
	}
	if (!row) {
		logger.error('Live session insert returned no row', { workspace_id: workspaceId })
		return c.json(createApiError('INTERNAL_ERROR', 'Could not start the live call'), 500)
	}

	await trackLiveSessionStarted(humanId, {
		live_session_id: row.id,
		agent_id: agent.id,
		agent_name: agent.name,
		workspace_id: workspaceId,
		conversation_id: row.conversationId,
		input_mode: row.inputMode,
		llm_route: creds.route,
		llm_model: creds.llmModel,
		provider: row.provider,
	})

	const wsPath = `/api/live-sessions/${row.id}/stream${body.opening ? `?opening=${body.opening}` : ''}`
	return c.json(
		{
			live_session: toLiveSessionResponse(row),
			ws_url: wsPath,
			protocol_version: LIVE_PROTOCOL_VERSION as 1,
		},
		201,
	)
})

// ── Get ──────────────────────────────────────────────────────────────

const idParam = z.object({ id: z.string().uuid() })

const getRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Live'],
	summary: 'Read one of your live sessions',
	request: { params: idParam },
	responses: {
		200: {
			description: 'The session',
			content: { 'application/json': { schema: sessionResponse } },
		},
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(getRoute, async (c) => {
	const humanId = c.get('actorId')
	const db = c.get('db')
	const { id } = c.req.valid('param')
	if (!isFlagEnabled(humanId, FLAGS.LIVE_MODE))
		return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
	const [row] = await db.select().from(liveSessions).where(eq(liveSessions.id, id)).limit(1)
	// A session that is not yours is a 404, so ids cannot be probed.
	if (
		!row ||
		row.humanActorId !== humanId ||
		!(await isWorkspaceMember(db, humanId, row.workspaceId))
	) {
		return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
	}
	return c.json(toLiveSessionResponse(row), 200)
})

// ── End ──────────────────────────────────────────────────────────────

const endRoute = createRoute({
	method: 'post',
	path: '/{id}/end',
	tags: ['Live'],
	summary: 'End a live session',
	description: 'Idempotent. Ending a session that already ended returns its final state.',
	request: {
		params: idParam,
		body: { content: { 'application/json': { schema: endBody } }, required: false },
	},
	responses: {
		200: { description: 'Final state', content: { 'application/json': { schema: endResponse } } },
		404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(endRoute, async (c) => {
	const humanId = c.get('actorId')
	const db = c.get('db')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json') ?? { reason: 'user_hangup' as const }
	if (!isFlagEnabled(humanId, FLAGS.LIVE_MODE))
		return c.json(createApiError('NOT_FOUND', 'Not found'), 404)

	const [existing] = await db.select().from(liveSessions).where(eq(liveSessions.id, id)).limit(1)
	if (
		!existing ||
		existing.humanActorId !== humanId ||
		!(await isWorkspaceMember(db, humanId, existing.workspaceId))
	) {
		return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
	}

	const ended = await endLiveSession(db, { id, reason: body.reason })
	// Null means it had already ended (or lost a race); report the stored final state either way.
	const [row] = ended
		? [ended]
		: await db.select().from(liveSessions).where(eq(liveSessions.id, id)).limit(1)
	if (!row) return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
	const endedAt = row.endedAt
	return c.json(
		{
			live_session_id: row.id,
			status: row.status as z.infer<typeof endResponse>['status'],
			ended_reason: row.endedReason,
			ended_at: endedAt ? endedAt.toISOString() : null,
			duration_ms: endedAt ? endedAt.getTime() - row.startedAt.getTime() : null,
			total_cost_usd: Number(row.totalCostUsd),
			conversation_id: row.conversationId,
			turn_count: row.turnCount,
		},
		200,
	)
})

export default app
