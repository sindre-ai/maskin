import type { Database } from '@maskin/db'
import { sessionLogs } from '@maskin/db/schema'
import { SESSION_ACTIVITY_SCAN_ROWS, type SessionActivityTurn } from '@maskin/shared'
import { and, desc, eq, gte, inArray, like, lt } from 'drizzle-orm'
import { type ActivityLogRow, buildSessionActivity } from './session-activity'

/** Tagged envelopes inspected when hunting for a straddled turn's start (LIKE can over-match). */
const ENVELOPE_CANDIDATES = 20

export interface LoadActivityOptions {
	limitTurns: number
	messageId?: number
	beforeLogId?: number
}

export interface LoadedActivity {
	turns: SessionActivityTurn[]
	oldestLogId: number | null
	hasOlder: boolean
}

type LogRow = ActivityLogRow & { sessionId: string }

function isTurnStart(content: string, messageId?: number): boolean {
	try {
		const env = JSON.parse(content) as Record<string, unknown>
		return (
			env.type === 'user' &&
			env.maskin_retry !== true &&
			typeof env.maskin_message_id === 'number' &&
			(messageId === undefined || env.maskin_message_id === messageId)
		)
	} catch {
		return false
	}
}

/** Newest tagged user envelope strictly below `beforeId` (optionally for one message id). */
async function findTurnStart(
	db: Database,
	sessionId: string,
	beforeId: number | undefined,
	messageId?: number,
): Promise<LogRow | null> {
	const pattern =
		messageId === undefined ? '%maskin_message_id%' : `%"maskin_message_id":${messageId}%`
	const conditions = [
		eq(sessionLogs.sessionId, sessionId),
		eq(sessionLogs.stream, 'stdout'),
		like(sessionLogs.content, pattern),
	]
	if (beforeId !== undefined) conditions.push(lt(sessionLogs.id, beforeId))
	const candidates = await db
		.select()
		.from(sessionLogs)
		.where(and(...conditions))
		.orderBy(desc(sessionLogs.id))
		.limit(ENVELOPE_CANDIDATES)
	return candidates.find((r) => isTurnStart(r.content, messageId)) ?? null
}

/**
 * Loads the activity window for a session.
 *
 * Normally that is the newest SESSION_ACTIVITY_SCAN_ROWS rows. Two extensions
 * keep the bounded window from silently losing turns:
 *  - a full window that starts mid-turn gets that turn's tagged envelope
 *    prepended (one extra bounded query); the turn is flagged `partial`.
 *  - a `messageId` outside the window is looked up by anchoring a scan at its
 *    own envelope, so the turn is found however old it is.
 */
export async function loadSessionActivity(
	db: Database,
	sessionId: string,
	opts: LoadActivityOptions,
): Promise<LoadedActivity> {
	const base = [
		eq(sessionLogs.sessionId, sessionId),
		inArray(sessionLogs.stream, ['stdout', 'stderr']),
	]
	const windowConds = [...base]
	if (opts.beforeLogId) windowConds.push(lt(sessionLogs.id, opts.beforeLogId))

	let rows: ActivityLogRow[] = (
		await db
			.select()
			.from(sessionLogs)
			.where(and(...windowConds))
			.orderBy(desc(sessionLogs.id))
			.limit(SESSION_ACTIVITY_SCAN_ROWS)
	).reverse()
	let hasOlder = rows.length === SESSION_ACTIVITY_SCAN_ROWS
	let partialFirst = false

	if (hasOlder && rows[0] && !isTurnStart(rows[0].content)) {
		const start = await findTurnStart(db, sessionId, rows[0].id)
		if (start) {
			rows = [start, ...rows]
			partialFirst = true
		}
	}

	let turns = buildSessionActivity(rows)
	if (partialFirst && turns[0]) turns[0] = { ...turns[0], partial: true }

	if (opts.messageId !== undefined) {
		turns = turns.filter((t) => t.message_id === opts.messageId)
		if (turns.length === 0) {
			const anchor = await findTurnStart(db, sessionId, opts.beforeLogId, opts.messageId)
			if (anchor) {
				const forward = await db
					.select()
					.from(sessionLogs)
					.where(and(...base, gte(sessionLogs.id, anchor.id)))
					.orderBy(sessionLogs.id)
					.limit(SESSION_ACTIVITY_SCAN_ROWS)
				const anchored = buildSessionActivity(forward).filter(
					(t) => t.message_id === opts.messageId,
				)
				turns = anchored.slice(0, 1)
				rows = forward
				hasOlder = true
			}
		}
	}

	turns = turns.slice(-opts.limitTurns)
	return { turns, oldestLogId: rows[0]?.id ?? null, hasOlder }
}
