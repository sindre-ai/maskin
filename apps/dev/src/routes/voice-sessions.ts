import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { issueApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	actors,
	agentSkills,
	notificationPreferences,
	voiceSessions,
	workspaceMembers,
	workspaceSkills,
	workspaces,
} from '@maskin/db/schema'
import { createVoiceToolkit, selectVoiceRealtimeTools } from '@maskin/mcp'
import type { VoiceToolkit } from '@maskin/mcp'
import { resolveWebAppBaseUrl } from '@maskin/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
	captureLiveCallStarted,
	captureVoiceSessionDenied,
	captureVoiceSessionStarted,
} from '../lib/analytics/voice-events'
import { createApiError, validationFailureHook } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { captureVoiceException } from '../lib/sentry-voice'
import { getWorkspaceRole, isWorkspaceWriter } from '../lib/workspace-auth'
import { resolveVoiceAgentMcpServers } from '../services/voice-agent-mcp'
import { cardIdOf, readStartCards } from '../services/voice-call-state'
import {
	findReadableConversationId,
	formatVoiceChatHistory,
	loadVoiceChatHistory,
} from '../services/voice-chat-history'
import {
	VOICE_ASK_WORKSPACE_TOOL,
	openAiDelegateModel,
	resolveVoiceDelegateModel,
	resolveVoiceToolMode,
	voiceAskWorkspaceTool,
} from '../services/voice-delegate'
import { buildVoiceInstructions } from '../services/voice-instructions'
import {
	VOICE_OFFER_CLAIM,
	VOICE_REALTIME_MODEL,
	attachVoiceCall,
	closeVoiceCall,
	createRealtimeCall,
	realtimeCallsUrl,
	resolveRealtimeVoice,
} from '../services/voice-realtime-call'
import { postClosingReceipt } from '../services/voice-receipt'
import { VOICE_WAIT_FOR_USER_TOOL, voiceWaitForUserTool } from '../services/voice-session-channel'
import {
	endVoiceSession,
	setCloseVendorSessionFn,
	setEndedReceiptFn,
} from '../services/voice-session-lifecycle'
import { VOICE_SHOW_IN_CHAT_TOOL, voiceShowInChatTool } from '../services/voice-show-in-chat'
import { listVoiceToolCalls } from '../services/voice-tool-call-log'
import { isTranscriptPersistenceEnabled } from '../services/voice-transcript'
import { withConfirmationArg } from '../services/voice-write-gate'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// Ending a call (hangup, sweeper, shutdown, socket drop) closes the server
// socket and hangs the call up at OpenAI.
setCloseVendorSessionFn(closeVoiceCall)
// ...and leaves one closing receipt in the call's chat, whichever path ended it.
setEndedReceiptFn((db, ended, info) => postClosingReceipt(db, ended, { reason: info.reason }))

// ── Schemas ──────────────────────────────────────────────────────────

const createVoiceSessionBody = z
	.object({
		agent_actor_id: z.string().uuid().openapi({
			description: 'Actor id of the agent to call. Must be an agent that is a workspace member.',
		}),
		conversation_id: z.string().uuid().optional().openapi({
			description:
				'The chat the call is started from. When the caller is a participant of it, the agent is given its recent messages and the transcript is saved into it. Ignored otherwise.',
		}),
	})
	.openapi('CreateVoiceSessionBody')

const createVoiceSessionResponse = z
	.object({
		voice_session_id: z.string().uuid(),
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

/**
 * Builds the tools a call runs: every MCP tool chat has, plus the dispatcher
 * that runs them. Overridable in tests.
 */
export type VoiceInvokeToolFactory = (args: {
	db: Database
	apiKey: string
	workspaceId: string
	agentTools: unknown
}) => Promise<VoiceToolkit>

const defaultInvokeToolFactory: VoiceInvokeToolFactory = async ({
	db,
	apiKey,
	workspaceId,
	agentTools,
}) => {
	const apiBaseUrl = `http://localhost:${Number(process.env.PORT) || 3000}`
	// Only the servers the user added to this agent, exactly as in chat.
	const agentMcpServers = await resolveVoiceAgentMcpServers({
		db,
		agentTools,
		agentApiKey: apiKey,
		workspaceId,
		apiBaseUrl,
	})
	return createVoiceToolkit(
		{
			apiBaseUrl,
			// The agent's own key, so every write is attributed to the agent's actor
			// (voice_sessions.agent_actor_id) rather than the human speaking. It is
			// read server-side here and never sent to the browser.
			apiKey,
			defaultWorkspaceId: workspaceId,
			transport: 'http',
			webAppBaseUrl: resolveWebAppBaseUrl(process.env),
		},
		agentMcpServers,
	)
}

let invokeToolFactory: VoiceInvokeToolFactory = defaultInvokeToolFactory

export function setVoiceInvokeToolFactory(fn: VoiceInvokeToolFactory | null): void {
	invokeToolFactory = fn ?? defaultInvokeToolFactory
}

// ── Insert-failure + cleanup helpers ─────────────────────────────────

const PG_UNIQUE_VIOLATION = '23505'

/** Lifetime of the key a voice call uses to run the agent's tools. */
const VOICE_AGENT_KEY_TTL_MS = 2 * 60 * 60 * 1000

/**
 * Drizzle wraps driver errors, so the Postgres code lives on err.cause.code
 * rather than err.code. Walk the cause chain (bounded) and match either.
 */
function isUniqueViolation(err: unknown): boolean {
	let current: unknown = err
	for (let depth = 0; depth < 5 && current; depth++) {
		if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true
		current = (current as { cause?: unknown }).cause
	}
	return false
}

/**
 * The pending row is inserted before the vendor call, so a failed or
 * rate-limited offer must release it, otherwise the one-live-call-per-human
 * partial unique index locks the caller out until timeout_at. Marked errored
 * rather than deleted to keep the audit trail; no voice_session_ended fires
 * because the call never began.
 */
async function releasePendingSession(db: Database, id: string): Promise<void> {
	try {
		await db
			.update(voiceSessions)
			.set({
				status: 'errored',
				endedReason: 'vendor_error',
				endedAt: new Date(),
				// Drop the offer claim so the row does not read as having a vendor call.
				vendorSessionId: null,
			})
			.where(and(eq(voiceSessions.id, id), eq(voiceSessions.status, 'pending')))
	} catch (err) {
		logger.error('Failed to release pending voice session after vendor connect failure', {
			voice_session_id: id,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

// ── Route ────────────────────────────────────────────────────────────

const postVoiceSessionRoute = createRoute({
	method: 'post',
	path: '/',
	'x-viewer-policy': 'writer',
	tags: ['Voice'],
	summary: 'Start a 1:1 voice call: reserve the caller’s live-call slot',
	description:
		"Any agent in the workspace can be called: the agent's own voice_enabled field is not checked. Body: { agent_actor_id, conversation_id? }. On success, inserts a voice_sessions row (status=pending) and returns its id. The browser then posts its WebRTC offer to POST /voice-sessions/{id}/offer. No credential is returned: the connection to the vendor is made by the server.",
	request: {
		body: {
			content: { 'application/json': { schema: createVoiceSessionBody } },
			required: true,
		},
	},
	responses: {
		201: {
			description: 'Voice session reserved',
			content: { 'application/json': { schema: createVoiceSessionResponse } },
		},
		400: {
			description: 'Target actor is not an agent',
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
		500: {
			description: 'The reservation row could not be written',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(postVoiceSessionRoute, async (c) => {
	const humanActorId = c.get('actorId')
	const db = c.get('db')

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

	// A call acts through the agent and saves a transcript: a viewer is read-only.
	await isWorkspaceWriter(db, humanActorId, workspaceId)

	const [agent] = await db
		.select({
			id: actors.id,
			type: actors.type,
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

	if (agent.type !== 'agent') {
		await captureVoiceSessionDenied(humanActorId, {
			agent_id: agentActorId,
			workspace_id: workspaceId,
			reason: 'no_active_agent',
		})
		return c.json(createApiError('BAD_REQUEST', 'Target actor is not an agent'), 400)
	}

	// A call started from a chat carries that chat's history and saves its transcript
	// there. A chat the caller cannot read is ignored, not an error, so a stale id
	// never blocks the call.
	let conversationId: string | null = null
	if (body.conversation_id) {
		conversationId = await findReadableConversationId(db, {
			conversationId: body.conversation_id,
			workspaceId,
			humanActorId,
		})
		if (!conversationId) {
			logger.warn('Voice call started from a conversation the caller cannot read; ignoring it', {
				workspace_id: workspaceId,
				agent_actor_id: agentActorId,
			})
		}
	}

	// The DB unique index on (human_actor_id) partial to status IN
	// ('pending','active') resolves the concurrent-active race at the storage
	// layer.
	let inserted: { id: string } | null = null
	try {
		const [row] = await db
			.insert(voiceSessions)
			.values({
				workspaceId,
				agentActorId,
				humanActorId,
				conversationId,
				status: 'pending',
				vendor: 'openai_realtime',
				model: VOICE_REALTIME_MODEL,
				timeoutAt: new Date(Date.now() + 15 * 60 * 1000),
			})
			.returning({ id: voiceSessions.id })
		inserted = row ?? null
	} catch (err) {
		// On the partial unique index a unique_violation only fires when the
		// caller already has a pending/active row — the "one live call per
		// human" invariant.
		if (isUniqueViolation(err)) {
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
		logger.error('Voice session insert returned no row', { workspace_id: workspaceId })
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to insert voice_sessions row'), 500)
	}

	return c.json({ voice_session_id: inserted.id }, 201)
})

// ── Offer ────────────────────────────────────────────────────────────

const offerBody = z
	.object({
		sdp: z.string().min(1).max(100_000).openapi({
			description: 'The browser’s WebRTC SDP offer.',
		}),
		noise_reduction: z.enum(['near_field', 'far_field']).optional().openapi({
			description:
				'Microphone type: near_field for headsets and phones, far_field for a laptop mic. Absent means far_field.',
		}),
	})
	.openapi('VoiceSessionOfferBody')

const offerResponse = z
	.object({
		sdp: z.string().openapi({ description: 'The SDP answer to set as the remote description.' }),
		tools_available: z.boolean().openapi({
			description:
				'False when the server could not attach its tool connection to the call. The browser then answers every tool call with an "unavailable" result so the agent says so.',
		}),
		persist_transcripts: z.boolean(),
	})
	.openapi('VoiceSessionOfferResponse')

const postOfferRoute = createRoute({
	method: 'post',
	path: '/{id}/offer',
	'x-viewer-policy': 'writer',
	tags: ['Voice'],
	summary: 'Connect a reserved voice session to the vendor',
	description:
		'Only the human who reserved the session, still a member of its workspace, can call this; anyone else gets 404. Accepts one offer per session. The server posts the SDP offer and the session config (instructions, tools, transcription) to the vendor with the operator key, attaches its own tool connection to the new call, and returns the SDP answer. During the call, tools that read and ordinary changes inside the workspace run at once; tools that send outside the workspace, start work, delete or change access are held until the person says yes out loud. The browser never receives a vendor credential.',
	request: {
		params: z.object({ id: z.string().uuid() }),
		body: { content: { 'application/json': { schema: offerBody } }, required: true },
	},
	responses: {
		200: {
			description: 'SDP answer',
			content: { 'application/json': { schema: offerResponse } },
		},
		404: {
			description: 'Flag off, no such session for the caller, or membership lapsed',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'The session already took an offer, or is no longer pending',
			content: { 'application/json': { schema: errorSchema } },
		},
		429: {
			description: 'Rate limited by the vendor; retry after `retry_after_seconds`',
			content: { 'application/json': { schema: rateLimitedResponse } },
		},
		500: {
			description:
				'Voice is not configured (no operator key), the vendor connect failed, or the vendor refused it over quota or billing (message says the team has been notified) — the session row is released so the caller can start again',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(postOfferRoute, async (c) => {
	const humanActorId = c.get('actorId')
	const db = c.get('db')

	const { id } = c.req.valid('param')
	const { sdp, noise_reduction: noiseReduction } = c.req.valid('json')

	// A session that is not the caller's is a 404, so ids are not probeable.
	const [session] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)).limit(1)
	if (!session || session.humanActorId !== humanActorId) {
		return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
	}

	// Live membership, checked here rather than trusted from the mint: a member
	// removed between the two cannot drive the call.
	// A member demoted to viewer in the meantime is refused too (403).
	if (!(await isWorkspaceWriter(db, humanActorId, session.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
	}

	if (session.status !== 'pending' || session.vendorSessionId !== null) {
		return c.json(createApiError('CONFLICT', 'This voice session already took an offer'), 409)
	}

	// Voice is billed to an operator key. Without it every vendor call is a 401
	// that reads as a vendor outage, so say what is wrong and free the slot.
	const apiKey = process.env.MASKIN_VOICE_OPENAI_API_KEY?.trim()
	if (!apiKey) {
		logger.error('Voice is not configured: MASKIN_VOICE_OPENAI_API_KEY is unset', {
			voice_session_id: session.id,
			workspace_id: session.workspaceId,
		})
		await releasePendingSession(db, session.id)
		return c.json(createApiError('INTERNAL_ERROR', 'Voice is not configured on this server'), 500)
	}

	const [agent] = await db
		.select({
			name: actors.name,
			systemPrompt: actors.systemPrompt,
			tools: actors.tools,
		})
		.from(actors)
		.where(eq(actors.id, session.agentActorId))
		.limit(1)
	if (!agent) {
		logger.error('Voice session agent not found', {
			voice_session_id: session.id,
			agent_actor_id: session.agentActorId,
		})
		captureVoiceException(session.id, new Error('Voice session agent not found'))
		await releasePendingSession(db, session.id)
		return c.json(createApiError('INTERNAL_ERROR', 'Voice session cannot run tools'), 500)
	}

	// Claim the single offer. Two concurrent offers race on this UPDATE and one
	// loses, so the vendor is only ever called once per session.
	const claimed = await db
		.update(voiceSessions)
		.set({ vendorSessionId: VOICE_OFFER_CLAIM })
		.where(
			and(
				eq(voiceSessions.id, session.id),
				eq(voiceSessions.status, 'pending'),
				isNull(voiceSessions.vendorSessionId),
			),
		)
		.returning({ id: voiceSessions.id })
	if (claimed.length === 0) {
		return c.json(createApiError('CONFLICT', 'This voice session already took an offer'), 409)
	}

	// Compose the vendor `instructions` from the agent's system prompt + every
	// attached workspace skill's rendered content. Same substrate the chat
	// side already binds — so a voice caller and a text caller see the same
	// agent identity + skills.
	const skillRows = await db
		.select({ content: workspaceSkills.content, name: workspaceSkills.name })
		.from(agentSkills)
		.innerJoin(workspaceSkills, eq(workspaceSkills.id, agentSkills.workspaceSkillId))
		.where(eq(agentSkills.actorId, session.agentActorId))

	// Who is calling and their time zone (when they have set one), so the agent knows the date.
	const [caller] = await db
		.select({ name: actors.name, timezone: notificationPreferences.timezone })
		.from(actors)
		.leftJoin(notificationPreferences, eq(notificationPreferences.actorId, actors.id))
		.where(eq(actors.id, humanActorId))
		.limit(1)

	// The chat the call was started from, re-checked here: the caller may have left it
	// between the two requests.
	let chatHistory = ''
	if (
		session.conversationId &&
		(await findReadableConversationId(db, {
			conversationId: session.conversationId,
			workspaceId: session.workspaceId,
			humanActorId,
		}))
	) {
		chatHistory = formatVoiceChatHistory(await loadVoiceChatHistory(db, session.conversationId))
	}

	// The names the transcription is told to expect. Missing ones are skipped: the hint is
	// never worth failing a call over.
	const [workspace] = await db
		.select({ name: workspaces.name })
		.from(workspaces)
		.where(eq(workspaces.id, session.workspaceId))
		.limit(1)
	const transcriptionNames = [caller?.name, agent.name, workspace?.name].filter(
		(n): n is string => typeof n === 'string',
	)

	const instructions = buildVoiceInstructions({
		systemPrompt: agent.systemPrompt,
		workspaceId: session.workspaceId,
		voiceSessionId: session.id,
		caller: { id: humanActorId, name: caller?.name ?? null, timezone: caller?.timezone ?? null },
		skills: skillRows,
		chatHistory,
	})

	let toolkit: Awaited<ReturnType<VoiceInvokeToolFactory>>
	try {
		// Stored keys are hashed, so the call gets its own. The daily cap keeps one call under an
		// hour; the expiry is the backstop that closes the key if the call never ends cleanly.
		const { key: agentApiKey } = await issueApiKey(db, {
			actorId: session.agentActorId,
			kind: 'session',
			expiresAt: new Date(Date.now() + VOICE_AGENT_KEY_TTL_MS),
		})
		toolkit = await invokeToolFactory({
			db,
			apiKey: agentApiKey,
			workspaceId: session.workspaceId,
			agentTools: agent.tools,
		})
	} catch (err) {
		await releasePendingSession(db, session.id)
		throw err
	}
	// show_in_chat is the call's own tool (see services/voice-show-in-chat.ts): not in the MCP
	// toolkit, and not a write, so it takes no confirmation_id and is never held.
	// wait_for_user is also the call's own: it does nothing and is never held.
	// ask_workspace is not held itself: every tool it runs goes through the write gate one by one.
	const readOnlyTools = new Set([
		...toolkit.readOnlyTools,
		VOICE_SHOW_IN_CHAT_TOOL,
		VOICE_WAIT_FOR_USER_TOOL,
		VOICE_ASK_WORKSPACE_TOOL,
	])
	// The call's own tools, kept apart from the MCP toolkit's.
	// Core mode: the model gets a handful of tools plus ask_workspace, which runs the full
	// toolkit with a text model. Full mode (MASKIN_VOICE_TOOL_MODE=full) pins every tool.
	const toolMode = resolveVoiceToolMode()
	const callTools =
		toolMode === 'core'
			? [voiceShowInChatTool, voiceWaitForUserTool, voiceAskWorkspaceTool]
			: [voiceShowInChatTool, voiceWaitForUserTool]
	const realtimeTools = selectVoiceRealtimeTools(toolkit.tools, toolMode)
	const delegate =
		toolMode === 'core'
			? {
					tools: toolkit.tools,
					model: openAiDelegateModel({ apiKey, model: resolveVoiceDelegateModel() }),
				}
			: undefined
	let outcome: Awaited<ReturnType<typeof createRealtimeCall>>
	try {
		outcome = await createRealtimeCall({
			tools: withConfirmationArg([...realtimeTools, ...callTools], readOnlyTools),
			apiKey,
			callsUrl: realtimeCallsUrl(),
			offerSdp: sdp,
			instructions,
			voice: resolveRealtimeVoice(),
			transcriptionNames,
			noiseReduction,
			model: VOICE_REALTIME_MODEL,
		})
	} catch (err) {
		// Nothing owns the toolkit's connections yet, so close them here.
		void toolkit.close().catch(() => {})
		await releasePendingSession(db, session.id)
		throw err
	}

	if (outcome.kind !== 'ok') void toolkit.close().catch(() => {})

	if (outcome.kind === 'quota_exhausted') {
		await releasePendingSession(db, session.id)
		logger.error('Voice vendor refused the call: quota or billing', {
			voice_session_id: session.id,
			workspace_id: session.workspaceId,
			agent_actor_id: session.agentActorId,
			vendor_status: 429,
			vendor_body: outcome.vendorBody.slice(0, 500),
		})
		captureVoiceException(
			session.id,
			new Error('Voice vendor returned 429 for quota or billing (insufficient_quota)'),
		)
		return c.json(
			createApiError('INTERNAL_ERROR', 'Voice is unavailable, the team has been notified'),
			500,
		)
	}

	if (outcome.kind === 'rate_limited') {
		await releasePendingSession(db, session.id)
		logger.warn('Voice vendor rate limited the call', {
			voice_session_id: session.id,
			workspace_id: session.workspaceId,
			agent_actor_id: session.agentActorId,
			vendor_status: 429,
			retry_after_seconds: outcome.retryAfterSeconds,
			vendor_body: (outcome.vendorBody ?? '').slice(0, 500),
		})
		await captureVoiceSessionDenied(humanActorId, {
			agent_id: session.agentActorId,
			workspace_id: session.workspaceId,
			reason: 'rate_limited',
		})
		return c.json(
			{
				error: {
					code: 'RATE_LIMITED' as const,
					message: `Voice is busy at OpenAI, try again in ${outcome.retryAfterSeconds} seconds`,
				},
				retry_after_seconds: outcome.retryAfterSeconds,
			},
			429,
		)
	}

	if (outcome.kind === 'error') {
		await releasePendingSession(db, session.id)
		logger.error('Voice call connect failed at vendor', {
			voice_session_id: session.id,
			workspace_id: session.workspaceId,
			agent_actor_id: session.agentActorId,
			vendor_status: outcome.status,
			vendor_body: outcome.body.slice(0, 500),
		})
		captureVoiceException(
			session.id,
			new Error(`Voice vendor call connect failed (status ${outcome.status})`),
		)
		return c.json(
			createApiError('INTERNAL_ERROR', `Vendor connect failed (status ${outcome.status})`),
			500,
		)
	}

	try {
		// Record the vendor call id on our row so hangup and the lifecycle routes
		// can find the call at the vendor.
		await db
			.update(voiceSessions)
			.set({ vendorSessionId: outcome.callId, model: VOICE_REALTIME_MODEL })
			.where(eq(voiceSessions.id, session.id))
	} catch (err) {
		void toolkit.close().catch(() => {})
		// The call exists at the vendor but we cannot track it: hang it up so it
		// does not run unmetered.
		await closeVoiceCall({ voiceSessionId: session.id, vendorSessionId: outcome.callId })
		await releasePendingSession(db, session.id)
		throw err
	}

	// The top of the ranked list is read before the call is attached, so the call's channel and its
	// closing receipt share the same list.
	const startCards = await readStartCards(db, session)
	const [toolsAvailable, persistTranscripts] = await Promise.all([
		attachVoiceCall({
			db,
			session: { ...session, vendorSessionId: outcome.callId },
			agentName: agent.name,
			invokeTool: toolkit.invokeTool,
			readOnlyTools,
			delegate,
			dispose: () => toolkit.close(),
			callId: outcome.callId,
			apiKey,
		}),
		isTranscriptPersistenceEnabled(db, session.workspaceId),
	])

	await captureVoiceSessionStarted(humanActorId, {
		voice_session_id: session.id,
		agent_id: session.agentActorId,
		agent_name: agent.name,
		workspace_id: session.workspaceId,
		conversation_id: session.conversationId,
		model: VOICE_REALTIME_MODEL,
		vendor: 'openai_realtime',
	})
	const topCard = startCards?.[0]
	void captureLiveCallStarted(humanActorId, {
		voice_session_id: session.id,
		actor_id: humanActorId,
		workspace_id: session.workspaceId,
		rank_1_card_id: topCard ? cardIdOf(topCard) : null,
	})

	return c.json(
		{
			sdp: outcome.answerSdp,
			tools_available: toolsAvailable,
			persist_transcripts: persistTranscripts,
		},
		200,
	)
})

// ── Hangup ───────────────────────────────────────────────────────────

const hangupBody = z
	.object({
		reason: z.enum(['user_hangup', 'network_error']).openapi({
			description:
				'Why the browser is ending the call. user_hangup for End call / Esc / close; network_error when the one ICE restart did not recover the connection.',
		}),
		input_audio_seconds: z
			.number()
			.int()
			.min(0)
			.max(24 * 60 * 60)
			.optional()
			.openapi({
				description: 'Seconds of microphone audio the client sent. Clamped to the call length.',
			}),
		output_audio_seconds: z
			.number()
			.int()
			.min(0)
			.max(24 * 60 * 60)
			.optional()
			.openapi({
				description: 'Seconds of agent audio the client received. Clamped to the call length.',
			}),
	})
	.openapi('HangupVoiceSessionBody')

const hangupResponse = z
	.object({
		voice_session_id: z.string().uuid(),
		status: z.string(),
		ended_reason: z.string().nullable(),
		ended_at: z.string().nullable(),
		duration_ms: z.number(),
		total_cost_usd: z.number().nullable(),
		conversation_id: z.string().uuid().nullable(),
	})
	.openapi('HangupVoiceSessionResponse')

const hangupVoiceSessionRoute = createRoute({
	method: 'post',
	path: '/{id}/hangup',
	tags: ['Voice'],
	summary: 'End a voice call',
	description:
		"Marks the caller's voice_sessions row ended, stamps ended_at and ended_reason, finalises audio seconds and total_cost_usd, and fires voice_session_ended. Idempotent: hanging up a call that already ended returns its stored terminal state and fires nothing.",
	request: {
		params: z.object({ id: z.string().uuid() }),
		body: { content: { 'application/json': { schema: hangupBody } }, required: true },
	},
	responses: {
		200: {
			description: 'Call ended (or already ended)',
			content: { 'application/json': { schema: hangupResponse } },
		},
		404: {
			description: 'Flag off, or no such voice session for the caller',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(hangupVoiceSessionRoute, async (c) => {
	const humanActorId = c.get('actorId')
	const db = c.get('db')

	// A session that is not the caller's is a 404, so ids are not probeable.
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const [session] = await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)).limit(1)
	if (!session || session.humanActorId !== humanActorId) {
		return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
	}

	try {
		const isLive = session.status === 'pending' || session.status === 'active'
		const final = isLive
			? ((await endVoiceSession(db, {
					id,
					reason: body.reason,
					reportedInputAudioSeconds: body.input_audio_seconds,
					reportedOutputAudioSeconds: body.output_audio_seconds,
				})) ??
				// Lost the race to another terminal path between the read and the write.
				(await db.select().from(voiceSessions).where(eq(voiceSessions.id, id)).limit(1))[0] ??
				session)
			: session

		const endedAt = final.endedAt ?? null
		return c.json(
			{
				voice_session_id: final.id,
				status: final.status,
				ended_reason: final.endedReason,
				ended_at: endedAt?.toISOString() ?? null,
				duration_ms: (endedAt ?? new Date()).getTime() - final.startedAt.getTime(),
				total_cost_usd: final.totalCostUsd === null ? null : Number(final.totalCostUsd),
				conversation_id: final.conversationId,
			},
			200,
		)
	} catch (err) {
		captureVoiceException(id, err)
		throw err
	}
})

// ── Tool call log ────────────────────────────────────────────────────

const TOOL_CALLS_DEFAULT_LIMIT = 50
const TOOL_CALLS_MAX_LIMIT = 200

const toolCallsQuery = z.object({
	// z.coerce turns 'abc' into NaN, which fails int(), so a bad limit is a 400, never a NaN in SQL.
	limit: z.coerce.number().int().min(1).max(TOOL_CALLS_MAX_LIMIT).default(TOOL_CALLS_DEFAULT_LIMIT),
	cursor: z.string().min(1).max(200).optional(),
})

const toolCallItem = z
	.object({
		id: z.string().uuid(),
		voice_session_id: z.string().uuid(),
		call_id: z.string().nullable(),
		started_at: z.string(),
		tool_name: z.string(),
		args_summary: z.unknown().openapi({
			description: 'The arguments the model sent, redacted and size-capped.',
		}),
		success: z.boolean(),
		error_code: z.string().nullable(),
		error_message: z.string().nullable(),
		output_chars: z.number().int().openapi({
			description: "Length of the tool's output before voice's 20,000-character cap.",
		}),
		output_truncated: z.boolean(),
		latency_ms: z.number().int(),
		output_preview: z.string().nullable().openapi({
			description: 'The first ~500 characters of what the model was told, redacted.',
		}),
	})
	.openapi('VoiceToolCall')

const toolCallsResponse = z
	.object({
		tool_calls: z.array(toolCallItem),
		next_cursor: z.string().nullable(),
	})
	.openapi('VoiceToolCallList')

function encodeToolCallCursor(row: { startedAt: Date; id: string }): string {
	return Buffer.from(`${row.startedAt.toISOString()}|${row.id}`).toString('base64url')
}

function decodeToolCallCursor(raw: string): { startedAt: Date; id: string } | null {
	try {
		const [iso, id] = Buffer.from(raw, 'base64url').toString().split('|')
		const startedAt = new Date(iso ?? '')
		if (!id || !z.string().uuid().safeParse(id).success || Number.isNaN(startedAt.getTime())) {
			return null
		}
		return { startedAt, id }
	} catch {
		return null
	}
}

const listToolCallsRoute = createRoute({
	method: 'get',
	path: '/{id}/tool-calls',
	tags: ['Voice'],
	summary: "List a voice call's tool calls",
	description:
		"What the voice model asked each tool to do and what came back: tool, redacted arguments, success, error, output length, whether the 20,000-character cap cut it, latency, and the first ~500 characters of the output. Oldest first, paged with `cursor`. Visible to the person on the call and to workspace owners and admins. Rows are kept 30 days. A call's tool calls that could not be logged are missing, not failed.",
	request: {
		headers: workspaceIdHeader,
		params: z.object({ id: z.string().uuid() }),
		query: toolCallsQuery,
	},
	responses: {
		200: {
			description: 'A page of tool calls',
			content: { 'application/json': { schema: toolCallsResponse } },
		},
		400: {
			description: 'Bad limit or cursor',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'No such voice session in this workspace, or not visible to the caller',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listToolCallsRoute, async (c) => {
	const actorId = c.get('actorId')
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const { limit, cursor } = c.req.valid('query')

	// The call must belong to the workspace in the header, so ids are not probeable across workspaces.
	const [session] = await db
		.select({ id: voiceSessions.id, humanActorId: voiceSessions.humanActorId })
		.from(voiceSessions)
		.where(and(eq(voiceSessions.id, id), eq(voiceSessions.workspaceId, workspaceId)))
		.limit(1)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
	if (session.humanActorId !== actorId) {
		const role = await getWorkspaceRole(db, actorId, workspaceId)
		if (role !== 'owner' && role !== 'admin') {
			return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
		}
	}

	let after: { startedAt: Date; id: string } | null = null
	if (cursor) {
		after = decodeToolCallCursor(cursor)
		if (!after) return c.json(createApiError('VALIDATION_ERROR', 'Invalid cursor'), 400)
	}

	const rows = await listVoiceToolCalls(db, {
		voiceSessionId: id,
		workspaceId,
		limit: limit + 1,
		after,
	})
	const page = rows.slice(0, limit)
	const last = page[page.length - 1]
	return c.json(
		{
			tool_calls: page.map((r) => ({
				id: r.id,
				voice_session_id: r.voiceSessionId,
				call_id: r.callId,
				started_at: r.startedAt.toISOString(),
				tool_name: r.toolName,
				args_summary: r.argsSummary ?? null,
				success: r.success,
				error_code: r.errorCode,
				error_message: r.errorMessage,
				output_chars: r.outputChars,
				output_truncated: r.outputTruncated,
				latency_ms: r.latencyMs,
				output_preview: r.outputPreview,
			})),
			next_cursor: rows.length > limit && last ? encodeToolCallCursor(last) : null,
		},
		200,
	)
})

export default app
