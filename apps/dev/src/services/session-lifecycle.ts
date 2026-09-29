/**
 * session-lifecycle.ts — the one entry point for starting a session.
 *
 * Every start-side wrapper (chat, triggers, REST, MCP, onboarding, self-spawn)
 * routes through startSession(). settleSession() (Bet #1 Commit 2) will live
 * in this same module. Per the tech spec §14 + §20, this file is the ONLY
 * module in apps/dev/src/** allowed to call the underlying dispatch primitives
 * — SessionDispatchQueue.enqueue(), SessionDispatcher.dispatch/markDispatched,
 * AgentServerClient.startSession(), ContainerManager.create/start, and the
 * legacy SessionManager.createSession() / SessionManager.startSession(sessionId).
 *
 * A ts-morph guard test pins that invariant; see
 * no-session-start-outside-lifecycle.guard.test.ts.
 */
import { and, sql as drizzleSql, eq } from 'drizzle-orm'

import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db'

import { logger } from '../lib/logger'
import type { CreateSessionParams, SessionManager } from './session-manager'

// ── Types (spec §14.1) ────────────────────────────────────────────────────

export type AwaitMode = 'none' | 'boot' | 'first-response' | 'terminal'

export type SessionLifecycleState =
	| 'queued'
	| 'waiting_for_machine'
	| 'starting'
	| 'running'
	| 'done'

export type SessionCallerKind =
	| 'chat'
	| 'trigger'
	| 'mcp-create-session'
	| 'mcp-run-agent'
	| 'rest'
	| 'internal'
	| 'plan-route'

export type SessionConfig = Record<string, unknown>

export interface StartSessionInput {
	workspaceId: string
	actorId: string
	callerKind: SessionCallerKind
	actionPrompt?: string
	config?: SessionConfig
	conversationId?: string
	triggerId?: string
	triggerSource?: string
	triggerType?: string
	sourceCommentEventId?: number
	parentSessionId?: string
	retryOf?: string
	attemptNumber?: number
	await?: AwaitMode
	awaitTimeoutMs?: number
	createdBy?: string
	autoStart?: boolean
}

export interface StartSessionHandle {
	sessionId: string
	state: SessionLifecycleState
	createdAt: Date
	awaitResult?: Promise<AwaitOutcome>
	/**
	 * The freshly-inserted sessions row. Present when startSession() actually
	 * inserted (the common case). Absent on an idempotency hit — the caller
	 * only receives sessionId/state/createdAt looked up off the existing row.
	 * Callers needing the full row (e.g. REST /api/sessions to serialize a 201
	 * body) should fetch by sessionId when this is undefined.
	 */
	session?: typeof sessions.$inferSelect
}

export type AwaitOutcome =
	| { kind: 'reached'; state: 'starting' | 'running'; at: Date }
	| { kind: 'first-response'; message: { role: 'assistant'; content: string } }
	| { kind: 'settled'; settle: { status: string } }
	| { kind: 'timed-out'; lastKnownState: SessionLifecycleState; waitedMs: number }

export interface SessionLifecycleEvent {
	sessionId: string
	from: SessionLifecycleState | null
	to: SessionLifecycleState
	at: Date
	metadata?: { host?: 'local' | 'remote'; queueDepth?: number; settle?: { status: string } }
}

export type OutcomeStreamCallback = (event: SessionLifecycleEvent) => void

// ── Configuration (module-scoped singleton, wired once from index.ts) ─────

interface LifecycleDeps {
	db: Database
	sessionManager: SessionManager
}

let _deps: LifecycleDeps | null = null

export function configureSessionLifecycle(deps: LifecycleDeps): void {
	_deps = deps
}

function getDeps(): LifecycleDeps {
	if (!_deps) {
		throw new Error('session-lifecycle not configured; call configureSessionLifecycle() at startup')
	}
	return _deps
}

// ── startSession() (spec §14.2, §14.4, §14.5) ─────────────────────────────

const AWAIT_DEFAULT_TIMEOUT_MS: Record<Exclude<AwaitMode, 'none'>, number> = {
	boot: 90_000,
	'first-response': 30_000,
	terminal: 30 * 60 * 1000,
}

/**
 * The one entry point for creating and starting a session.
 *
 * Single-tx behaviour (delegated to SessionManager.createSession, then the
 * commit-8 lifecycle fields are stamped after):
 *   1. Pre-flight billing-cap + conversation-anchor.
 *   2. Insert row with schema-default session_state='queued', state_entered_at=NOW().
 *   3. Insert session_created event.
 *   4. Insert conversation->session spawned edge if conversationId set.
 *   5. Fire outcomeStreamCallback with {to:'queued'}.
 *
 * Then branches on input.await (defaults to 'none'). For every non-'none'
 * mode, an awaitResult promise is attached to the handle that resolves per
 * spec §14.4. The session itself keeps running past the timeout — timing out
 * only affects the caller's wait.
 */
export async function startSession(
	input: StartSessionInput,
	outcomeStreamCallback?: OutcomeStreamCallback,
): Promise<StartSessionHandle> {
	const { db, sessionManager } = getDeps()

	// §14.5 — opt-in idempotency via input.config.idempotencyKey. Duplicate
	// submits from a jittery MCP client hit the same live row instead of
	// spawning a second session.
	const idempotencyKey = readIdempotencyKey(input.config)
	if (idempotencyKey) {
		const [existing] = await db
			.select({
				id: sessions.id,
				sessionState: sessions.sessionState,
				createdAt: sessions.createdAt,
			})
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, input.workspaceId),
					drizzleSql`${sessions.config}->>'idempotencyKey' = ${idempotencyKey}`,
				),
			)
			.limit(1)
		if (existing) {
			return {
				sessionId: existing.id,
				state: (existing.sessionState as SessionLifecycleState) ?? 'queued',
				createdAt: existing.createdAt ?? new Date(),
			}
		}
	}

	const createdBy = input.createdBy ?? input.actorId

	const params: CreateSessionParams = {
		actorId: input.actorId,
		actionPrompt: input.actionPrompt ?? '',
		config: input.config,
		triggerId: input.triggerId,
		triggerType: input.triggerType,
		triggerSource: input.triggerSource,
		sourceCommentEventId: input.sourceCommentEventId,
		createdBy,
		autoStart: input.autoStart,
		sourceSessionId: input.parentSessionId,
	}

	const session = await sessionManager.createSession(input.workspaceId, params)

	// Commit-8 lifecycle fields set on the fresh row. session_state='queued'
	// and state_entered_at=NOW() are schema defaults; attempt_number defaults
	// to 1. Only patch when a non-default is supplied.
	if (input.attemptNumber !== undefined || input.retryOf) {
		const patch: Record<string, unknown> = {}
		if (input.attemptNumber !== undefined) patch.attemptNumber = input.attemptNumber
		if (input.retryOf) patch.retryOf = input.retryOf
		if (Object.keys(patch).length > 0) {
			await db.update(sessions).set(patch).where(eq(sessions.id, session.id))
		}
	}

	if (outcomeStreamCallback) {
		try {
			outcomeStreamCallback({
				sessionId: session.id,
				from: null,
				to: 'queued',
				at: new Date(),
			})
		} catch (err) {
			logger.warn('outcomeStreamCallback threw on queued transition', {
				sessionId: session.id,
				error: String(err),
			})
		}
	}

	const initialState =
		((session as { sessionState?: SessionLifecycleState }).sessionState as
			| SessionLifecycleState
			| undefined) ?? 'queued'

	const handle: StartSessionHandle = {
		sessionId: session.id,
		state: initialState,
		createdAt: session.createdAt ?? new Date(),
		session,
	}

	const awaitMode = input.await ?? 'none'
	if (awaitMode !== 'none') {
		handle.awaitResult = pollForAwait(session.id, awaitMode, input.awaitTimeoutMs)
	}

	return handle
}

function readIdempotencyKey(config: SessionConfig | undefined): string | undefined {
	if (!config) return undefined
	const key = (config as { idempotencyKey?: unknown }).idempotencyKey
	return typeof key === 'string' && key.length > 0 ? key : undefined
}

/**
 * Poll the session row for state transitions matching the caller's awaitMode.
 * Terminal (session_state='done') always resolves. Never kills the session on
 * timeout — the promise just resolves 'timed-out' and the session keeps running.
 */
async function pollForAwait(
	sessionId: string,
	mode: AwaitMode,
	timeoutMsOverride?: number,
): Promise<AwaitOutcome> {
	const { db } = getDeps()
	const timeoutMs = timeoutMsOverride ?? (mode === 'none' ? 0 : AWAIT_DEFAULT_TIMEOUT_MS[mode])
	const startedAt = Date.now()
	const pollMs = 500
	let lastState: SessionLifecycleState = 'queued'

	while (Date.now() - startedAt < timeoutMs) {
		const [row] = await db
			.select({ sessionState: sessions.sessionState, status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		if (!row) break
		const state = (row.sessionState as SessionLifecycleState) ?? 'queued'
		lastState = state
		if (state === 'done') {
			return { kind: 'settled', settle: { status: row.status } }
		}
		if (mode === 'boot' && (state === 'starting' || state === 'running')) {
			return { kind: 'reached', state, at: new Date() }
		}
		if (mode === 'first-response' && state === 'running') {
			return { kind: 'reached', state, at: new Date() }
		}
		await new Promise((r) => setTimeout(r, pollMs))
	}
	return {
		kind: 'timed-out',
		lastKnownState: lastState,
		waitedMs: Date.now() - startedAt,
	}
}

/**
 * Internal: drive a queued session to running. Called from queue-drain paths
 * (e.g. SessionManager.startQueueDrain) that own an already-persisted row.
 * Currently delegates to SessionManager.startSession() — the local docker /
 * remote dispatch fork still lives there per §14.3.
 */
export function _driveToRunning(sessionId: string): Promise<void> {
	const { sessionManager } = getDeps()
	return sessionManager.startSession(sessionId).catch((err) => {
		logger.error('_driveToRunning failed', {
			sessionId,
			error: String(err),
		})
		throw err
	})
}
