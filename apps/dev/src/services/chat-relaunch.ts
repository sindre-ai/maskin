import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { TERMINAL_STATUSES } from './session-lifecycle'
import type { SessionManager } from './session-manager'

/** How often the old session row is re-read while waiting for it to end. */
export const RELAUNCH_POLL_MS = 250
/** No terminal status by now counts as a failed stop (tech spec 5.2.4). */
export const RELAUNCH_TERMINAL_CAP_MS = 10_000

/** stopped: the old session is gone (or there was none). failed: it may still be running. */
export type RelaunchOutcome = 'stopped' | 'failed'

type SessionControl = Pick<SessionManager, 'stopSession' | 'findConversationSessionAnyActive'>

export interface RelaunchDeps {
	db: Database
	sessionManager: SessionControl
	/** Test seams. */
	sleep?: (ms: number) => Promise<void>
	now?: () => number
}

export interface RelaunchTarget {
	workspaceId: string
	/** The session the key was vaulted from; names the conversation and the agent. */
	originSessionId: string
}

const terminal: ReadonlySet<string> = new Set(TERMINAL_STATUSES)

// One relaunch in flight per (conversation, agent). In-process on purpose: the
// sessions_conversation_actor_active_uniq index is the database backstop if a second
// process ever races this one.
const inFlight = new Map<string, Promise<RelaunchOutcome>>()

/**
 * Stops the session that holds a vaulted key in its env and waits until it has ended.
 * The respawn is not here: the client posts the redaction-marker message next, and the
 * conversation responder finds no active session and spawns a fresh one seeded with the
 * last 15 messages. pauseSession and resumeSession are never used: on a remote session
 * pauseSession marks the live one failed.
 *
 * A second vault for the same (conversation, agent) while one is in flight joins it
 * instead of stopping again.
 */
export async function relaunchChatSession(
	deps: RelaunchDeps,
	target: RelaunchTarget,
): Promise<RelaunchOutcome> {
	const origin = await loadOrigin(deps.db, target)
	if (!origin) return 'stopped'
	const key = lockKey(origin)
	const running = inFlight.get(key)
	if (running) return running
	return track(key, () => stopHoldingSession(deps, origin))
}

/**
 * Undo's half: waits for a relaunch in flight, then runs its own stop. No respawn, so
 * the next message starts a session that no longer has the key. Returns whether the
 * session is gone.
 */
export async function endSessionHoldingKey(
	deps: RelaunchDeps,
	target: RelaunchTarget,
): Promise<boolean> {
	const origin = await loadOrigin(deps.db, target)
	if (!origin) return true
	const key = lockKey(origin)
	const running = inFlight.get(key)
	if (running) await running.catch(() => undefined)
	return (await track(key, () => stopHoldingSession(deps, origin))) === 'stopped'
}

interface Origin {
	sessionId: string
	status: string
	actorId: string
	conversationId: string | null
}

async function loadOrigin(db: Database, target: RelaunchTarget): Promise<Origin | null> {
	const [row] = await db
		.select({
			sessionId: sessions.id,
			status: sessions.status,
			actorId: sessions.actorId,
			conversationId: sessions.conversationId,
		})
		.from(sessions)
		.where(
			and(eq(sessions.id, target.originSessionId), eq(sessions.workspaceId, target.workspaceId)),
		)
		.limit(1)
	return row ?? null
}

function lockKey(origin: Origin): string {
	return `${origin.conversationId ?? origin.sessionId}:${origin.actorId}`
}

function track(key: string, run: () => Promise<RelaunchOutcome>): Promise<RelaunchOutcome> {
	const promise = run().finally(() => {
		if (inFlight.get(key) === promise) inFlight.delete(key)
	})
	inFlight.set(key, promise)
	return promise
}

async function stopHoldingSession(deps: RelaunchDeps, origin: Origin): Promise<RelaunchOutcome> {
	const holder = await findHolder(deps, origin)
	// Nothing running, or still queued: a queued session reads the key when it is
	// dispatched, and the vault already committed.
	if (!holder || holder.status === 'pending' || holder.status === 'queued') return 'stopped'

	try {
		await deps.sessionManager.stopSession(holder.id)
	} catch (err) {
		// The message names the session id, never a secret. The old session keeps
		// running without the key, which is the safe direction.
		logger.warn('Relaunch: stopping the session failed', {
			sessionId: holder.id,
			error: err instanceof Error ? err.message : 'unknown',
		})
		return 'failed'
	}
	return (await waitForTerminal(deps, holder.id)) ? 'stopped' : 'failed'
}

async function findHolder(
	deps: RelaunchDeps,
	origin: Origin,
): Promise<{ id: string; status: string } | null> {
	if (origin.conversationId) {
		const active = await deps.sessionManager.findConversationSessionAnyActive(
			origin.conversationId,
			origin.actorId,
		)
		return active ? { id: active.id, status: active.status } : null
	}
	return terminal.has(origin.status) ? null : { id: origin.sessionId, status: origin.status }
}

async function waitForTerminal(deps: RelaunchDeps, sessionId: string): Promise<boolean> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
	const now = deps.now ?? Date.now
	const deadline = now() + RELAUNCH_TERMINAL_CAP_MS
	for (;;) {
		const [row] = await deps.db
			.select({ status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		if (!row || terminal.has(row.status)) return true
		if (now() >= deadline) return false
		await sleep(RELAUNCH_POLL_MS)
	}
}
