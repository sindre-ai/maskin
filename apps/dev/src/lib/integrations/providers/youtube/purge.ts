import type { Database } from '@maskin/db'
import { sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import { purgeYoutubeCache } from './cache'

/**
 * Clearing YouTube data we hold once the grant is gone (policy items P1 to P4). Two places hold
 * it: the in-memory read cache, and session logs, where a youtube__ tool result sits in the log
 * line of the session that called it.
 *
 * Sessions still moving (pending, starting, running, snapshotting) are never touched: a live
 * session owns its log stream. Paused and finished sessions are fair game.
 *
 * A log line counts as YouTube data when it contains youtube__ (every tool name starts with it).
 * strpos, not LIKE: an underscore is a LIKE wildcard.
 */
const LIVE_SESSION_STATUSES = sql`('pending', 'starting', 'running', 'snapshotting')`
const YOUTUBE_MARKER = 'youtube__'
const RETENTION_DAYS = 30

export interface YoutubePurgeTarget {
	integrationId: string
	workspaceId: string
}

/**
 * Delete ALL logs of every session in the workspace that is not live and has a youtube__ line.
 * Whole sessions go, not only the matching lines: the text around a tool result quotes it.
 */
export async function purgeYoutubeSessionLogs(db: Database, workspaceId: string): Promise<number> {
	const rows = await db.execute(sql`
		DELETE FROM session_logs
		WHERE session_id IN (
			SELECT s.id FROM sessions s
			WHERE s.workspace_id = ${workspaceId}
				AND s.status NOT IN ${LIVE_SESSION_STATUSES}
				AND EXISTS (
					SELECT 1 FROM session_logs l
					WHERE l.session_id = s.id AND strpos(l.content, ${YOUTUBE_MARKER}) > 0
				)
		)
		RETURNING id
	`)
	return rows.length
}

/**
 * Cache first, then logs. Each part has its own try block so a failing log delete never leaves
 * cached channel data behind. Never throws: the caller is a disconnect or a failed token.
 */
export async function purgeYoutubeData(db: Database, target: YoutubePurgeTarget): Promise<void> {
	try {
		purgeYoutubeCache(target.integrationId)
	} catch (err) {
		logger.warn('YouTube cache purge failed', {
			integrationId: target.integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	try {
		const deleted = await purgeYoutubeSessionLogs(db, target.workspaceId)
		logger.info('YouTube session logs purged', {
			integrationId: target.integrationId,
			workspaceId: target.workspaceId,
			deleted,
		})
	} catch (err) {
		logger.warn('YouTube session log purge failed', {
			integrationId: target.integrationId,
			workspaceId: target.workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

/**
 * The hourly sweep, called from SessionManager.pruneSessionLogs. Candidates are limited to
 * workspaces that have a youtube integration row, so the log scan never reaches other
 * workspaces. For sessions that are not live and contain a youtube__ line:
 *  - logs older than 30 days go, interactive sessions included (the general sweep exempts them);
 *  - every log goes when the workspace no longer has an active youtube integration.
 * Interactive sessions without a youtube__ line are never touched.
 */
export async function sweepYoutubeSessionLogs(
	db: Database,
	now: Date = new Date(),
): Promise<number> {
	const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
	const rows = await db.execute(sql`
		DELETE FROM session_logs sl
		USING sessions s
		WHERE sl.session_id = s.id
			AND s.workspace_id IN (SELECT i.workspace_id FROM integrations i WHERE i.provider = 'youtube')
			AND s.status NOT IN ${LIVE_SESSION_STATUSES}
			AND EXISTS (
				SELECT 1 FROM session_logs l
				WHERE l.session_id = s.id AND strpos(l.content, ${YOUTUBE_MARKER}) > 0
			)
			AND (
				sl.created_at < ${cutoff.toISOString()}::timestamptz
				OR NOT EXISTS (
					SELECT 1 FROM integrations a
					WHERE a.workspace_id = s.workspace_id AND a.provider = 'youtube' AND a.status = 'active'
				)
			)
		RETURNING sl.id
	`)
	return rows.length
}
