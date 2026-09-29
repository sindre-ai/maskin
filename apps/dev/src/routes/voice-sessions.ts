import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	actors,
	agentSkills,
	voiceSessions,
	workspaceMembers,
	workspaceSkills,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
	captureVoiceSessionDenied,
	captureVoiceSessionStarted,
} from '../lib/analytics/voice-events'
import { createApiError, validationFailureHook } from '../lib/errors'
import { FLAGS, isFlagEnabled } from '../lib/feature-flags'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// ── Schemas ──────────────────────────────────────────────────────────

const createVoiceSessionBody = z
	.object({
		agent_actor_id: z.string().uuid().openapi({
			description:
				'Actor id of the voice-enabled agent to call. Must be a workspace member and carry actors.metadata.voice_enabled=true.',
		}),
	})
	.openapi('CreateVoiceSessionBody')

const createVoiceSessionResponse = z
	.object({
		voice_session_id: z.string().uuid(),
		client_secret: z.string(),
		expires_at: z.string(),
		ws_url: z.string(),
	})
	.openapi('CreateVoiceSessionResponse')

const rateLimitedResponse = z
	.object({
		error: z.object({
			code: z.literal('RATE_LIMITED'),
			message: z.string(),
		}),
		retry_after_seconds: z.number(),
	})
	.openapi('VoiceSessionRateLimited')

// ── OpenAI Realtime session mint ─────────────────────────────────────

const DEFAULT_REALTIME_URL = 'https://api.openai.com/v1/realtime/sessions'
const DEFAULT_MODEL = 'gpt-realtime'
const DEFAULT_WS_URL = 'wss://api.openai.com/v1/realtime'
const DEFAULT_VOICE = 'verse'

interface RealtimeSessionResult {
	kind: 'ok'
	vendorSessionId: string
	clientSecret: string
	expiresAt: string
	wsUrl: string
	model: string
}

interface RealtimeRateLimited {
	kind: 'rate_limited'
	retryAfterSeconds: number
}

interface RealtimeError {
	kind: 'error'
	status: number
	body: string
}

type RealtimeMintOutcome = RealtimeSessionResult | RealtimeRateLimited | RealtimeError

/**
 * Test seam. Overridable via `setRealtimeMintFn` so contract tests can drive
 * every branch without hitting OpenAI. Default calls the real endpoint.
 */
export type RealtimeMintFn = (input: {
	apiKey: string
	instructions: string
	voice: string
	model: string
	realtimeUrl: string
}) => Promise<RealtimeMintOutcome>

let realtimeMintFn: RealtimeMintFn = defaultRealtimeMint

export function setRealtimeMintFn(fn: RealtimeMintFn | null): void {
	realtimeMintFn = fn ?? defaultRealtimeMint
}

async function defaultRealtimeMint(input: {
	apiKey: string
	instructions: string
	voice: string
	model: string
	realtimeUrl: string
}): Promise<RealtimeMintOutcome> {
	const body = {
		model: input.model,
		voice: input.voice,
		instructions: input.instructions,
		turn_detection: { type: 'server_vad' as const },
		// Tool whitelist lands in Task 3. Empty here so the vendor session
		// answers voice-only from the bound instructions.
		tools: [] as unknown[],
	}
	let res: Response
	try {
		res = await fetch(input.realtimeUrl, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${input.apiKey}`,
				'Content-Type': 'application/json',
				// OpenAI's Realtime API requires this header while the surface is
				// still labelled beta.
				'OpenAI-Beta': 'realtime=v1',
			},
			body: JSON.stringify(body),
		})
	} catch (err) {
		return { kind: 'error', status: 502, body: err instanceof Error ? err.message : String(err) }
	}
	if (res.status === 429) {
		const retryHeader = res.headers.get('retry-after')
		const parsed = retryHeader ? Number.parseInt(retryHeader, 10) : Number.NaN
		const retryAfterSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 30
		return { kind: 'rate_limited', retryAfterSeconds }
	}
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		return { kind: 'error', status: res.status, body: text }
	}
	// Response shape per OpenAI Realtime docs:
	//   { id, model, client_secret: { value, expires_at }, ... }
	// We parse defensively — a missing client_secret is a vendor contract
	// break, and we surface it as a 502 rather than a masked 201 with an
	// undefined secret.
	const json = (await res.json().catch(() => null)) as {
		id?: string
		model?: string
		client_secret?: { value?: string; expires_at?: number | string }
	} | null
	const vendorSessionId = json?.id
	const clientSecret = json?.client_secret?.value
	const rawExpiresAt = json?.client_secret?.expires_at
	if (!vendorSessionId || !clientSecret || rawExpiresAt === undefined) {
		return {
			kind: 'error',
			status: 502,
			body: 'Realtime response missing id / client_secret',
		}
	}
	// OpenAI ships `expires_at` as unix-seconds; normalise to an ISO string
	// so the wire response shape is transport-agnostic.
	const expiresAt =
		typeof rawExpiresAt === 'number' ? new Date(rawExpiresAt * 1000).toISOString() : rawExpiresAt
	return {
		kind: 'ok',
		vendorSessionId,
		clientSecret,
		expiresAt,
		wsUrl: process.env.MASKIN_VOICE_OPENAI_REALTIME_URL ?? DEFAULT_WS_URL,
		model: json?.model ?? input.model,
	}
}

// ── Route ────────────────────────────────────────────────────────────

const postVoiceSessionRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Voice'],
	summary: 'Mint an ephemeral OpenAI Realtime session for a 1:1 voice call',
	description:
		'Gated by the **voice-mode-v1** feature flag. Returns 404 when the flag is off for the calling actor. Body: { agent_actor_id }. On success, inserts a voice_sessions row (status=pending), calls the vendor session-mint endpoint with the operator OpenAI key, and returns the ephemeral client secret the browser needs to open the WebRTC handshake.',
	request: {
		body: {
			content: { 'application/json': { schema: createVoiceSessionBody } },
			required: true,
		},
	},
	responses: {
		201: {
			description: 'Ephemeral Realtime session',
			content: { 'application/json': { schema: createVoiceSessionResponse } },
		},
		400: {
			description: 'Target agent is not voice-enabled',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Flag off, or target agent not found in caller workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Caller already has a live voice session',
			content: { 'application/json': { schema: errorSchema } },
		},
		429: {
			description: 'Rate limited by the vendor; retry after `retry_after_seconds`',
			content: { 'application/json': { schema: rateLimitedResponse } },
		},
		500: {
			description: 'Vendor mint failed (network, contract break) — DB row rolls back',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(postVoiceSessionRoute, async (c) => {
	const humanActorId = c.get('actorId')
	const db = c.get('db')

	// Rail 3: flag gates the visual + session-mint surface. 404 (not 403) so
	// a non-tester never even learns the endpoint exists — matches every other
	// flag-gated route's shape.
	if (!isFlagEnabled(humanActorId, FLAGS.VOICE_MODE_V1)) {
		await captureVoiceSessionDenied(humanActorId, {
			agent_id: null,
			workspace_id: null,
			reason: 'flag_off',
		})
		return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
	}

	const body = c.req.valid('json')
	const agentActorId = body.agent_actor_id

	// Find one workspace where both the human and the agent are members —
	// the only workspace this mint can plausibly belong to. If the agent is
	// only in a different workspace than the caller, this returns nothing
	// (cross-workspace call) and we 404. `authMiddleware` has already proven
	// the human is authenticated; workspace scoping is what we still owe.
	const agentMember = alias(workspaceMembers, 'agent_member')
	const [membership] = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.innerJoin(
			agentMember,
			and(
				eq(agentMember.workspaceId, workspaceMembers.workspaceId),
				eq(agentMember.actorId, agentActorId),
			),
		)
		.where(eq(workspaceMembers.actorId, humanActorId))
		.limit(1)

	if (!membership) {
		await captureVoiceSessionDenied(humanActorId, {
			agent_id: agentActorId,
			workspace_id: null,
			reason: 'no_active_agent',
		})
		return c.json(createApiError('NOT_FOUND', 'Agent not found in this workspace'), 404)
	}

	const workspaceId = membership.workspaceId

	// Fetch the agent row so we can confirm voice_enabled=true and pull the
	// system prompt for the vendor `instructions`.
	const [agent] = await db
		.select({
			id: actors.id,
			name: actors.name,
			type: actors.type,
			systemPrompt: actors.systemPrompt,
			metadata: actors.metadata,
		})
		.from(actors)
		.where(eq(actors.id, agentActorId))
		.limit(1)

	if (!agent) {
		await captureVoiceSessionDenied(humanActorId, {
			agent_id: agentActorId,
			workspace_id: workspaceId,
			reason: 'no_active_agent',
		})
		return c.json(createApiError('NOT_FOUND', 'Agent not found'), 404)
	}

	const voiceEnabled =
		typeof agent.metadata === 'object' &&
		agent.metadata !== null &&
		(agent.metadata as Record<string, unknown>).voice_enabled === true
	if (agent.type !== 'agent' || !voiceEnabled) {
		await captureVoiceSessionDenied(humanActorId, {
			agent_id: agentActorId,
			workspace_id: workspaceId,
			reason: 'no_active_agent',
		})
		return c.json(createApiError('BAD_REQUEST', 'Target agent is not voice-enabled'), 400)
	}

	// Compose the vendor `instructions` from the agent's system prompt + every
	// attached workspace skill's rendered content. Same substrate the chat
	// side already binds — so a voice caller and a text caller see the same
	// agent identity + skills.
	const skillRows = await db
		.select({ content: workspaceSkills.content, name: workspaceSkills.name })
		.from(agentSkills)
		.innerJoin(workspaceSkills, eq(workspaceSkills.id, agentSkills.workspaceSkillId))
		.where(eq(agentSkills.actorId, agentActorId))

	const instructions = [
		agent.systemPrompt ?? '',
		...skillRows.map((row) => `\n\n## Skill: ${row.name}\n\n${row.content}`),
	]
		.join('')
		.trim()

	// Insert the voice_sessions row first, so a vendor mint that fails leaves
	// no orphan token and a vendor mint that succeeds is already durably
	// paired to the human/agent/workspace triple. The DB unique index on
	// (human_actor_id) partial to status IN ('pending','active') resolves the
	// concurrent-active race at the storage layer.
	let inserted: {
		id: string
		vendorSessionIdCol: string | null
	} | null = null
	try {
		const [row] = await db
			.insert(voiceSessions)
			.values({
				workspaceId,
				agentActorId,
				humanActorId,
				status: 'pending',
				vendor: 'openai_realtime',
				model: DEFAULT_MODEL,
				timeoutAt: new Date(Date.now() + 15 * 60 * 1000),
			})
			.returning({ id: voiceSessions.id, vendorSessionIdCol: voiceSessions.vendorSessionId })
		inserted = row ?? null
	} catch (err) {
		// Postgres unique_violation code is '23505'. On the partial unique
		// index this only fires when the caller already has a pending/active
		// row — the "one live call per human" invariant.
		const pgCode = (err as { code?: string }).code
		if (pgCode === '23505') {
			await captureVoiceSessionDenied(humanActorId, {
				agent_id: agentActorId,
				workspace_id: workspaceId,
				reason: 'concurrent_active',
			})
			return c.json(createApiError('CONFLICT', 'You already have a live voice session'), 409)
		}
		throw err
	}

	if (!inserted) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to insert voice_sessions row'), 500)
	}

	// Boot guard (voice-boot-guard.ts) ensures the env exists at boot when
	// the flag is on; a live handler read is safe.
	const openaiApiKey = process.env.MASKIN_VOICE_OPENAI_API_KEY ?? ''
	const realtimeUrl = process.env.MASKIN_VOICE_OPENAI_REALTIME_URL ?? DEFAULT_REALTIME_URL

	const outcome = await realtimeMintFn({
		apiKey: openaiApiKey,
		instructions,
		voice: DEFAULT_VOICE,
		model: DEFAULT_MODEL,
		realtimeUrl,
	})

	if (outcome.kind === 'rate_limited') {
		await captureVoiceSessionDenied(humanActorId, {
			agent_id: agentActorId,
			workspace_id: workspaceId,
			reason: 'rate_limited',
		})
		return c.json(
			{
				error: {
					code: 'RATE_LIMITED' as const,
					message: 'Vendor rate limit; retry after retry_after_seconds',
				},
				retry_after_seconds: outcome.retryAfterSeconds,
			},
			429,
		)
	}

	if (outcome.kind === 'error') {
		logger.error('Voice session mint failed at vendor', {
			voice_session_id: inserted.id,
			workspace_id: workspaceId,
			agent_actor_id: agentActorId,
			vendor_status: outcome.status,
			vendor_body: outcome.body.slice(0, 500),
		})
		return c.json(
			createApiError('INTERNAL_ERROR', `Vendor session mint failed (status ${outcome.status})`),
			500,
		)
	}

	// Record the vendor session id back on our row so the lifecycle routes
	// (Tasks 3/4) can look up an ended session against the vendor.
	await db
		.update(voiceSessions)
		.set({ vendorSessionId: outcome.vendorSessionId, model: outcome.model })
		.where(eq(voiceSessions.id, inserted.id))

	await captureVoiceSessionStarted(humanActorId, {
		voice_session_id: inserted.id,
		agent_id: agentActorId,
		agent_name: agent.name,
		workspace_id: workspaceId,
		conversation_id: null,
		model: outcome.model,
		vendor: 'openai_realtime',
	})

	return c.json(
		{
			voice_session_id: inserted.id,
			client_secret: outcome.clientSecret,
			expires_at: outcome.expiresAt,
			ws_url: outcome.wsUrl,
		},
		201,
	)
})

export default app
