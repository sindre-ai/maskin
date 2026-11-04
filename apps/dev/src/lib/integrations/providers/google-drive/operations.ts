import type { Database } from '@maskin/db'
import type { DriveApiFile, DriveClient } from './client'

/**
 * Shared pieces for the google_drive__* tool operations. One file per tool lives
 * under ./tools; this module holds only what two or more tools share, so tool
 * tasks stacked on this one add a file instead of editing the same lines.
 */

export interface DriveToolContext {
	db: Database
	/** From the verified request (membership-checked in the route), never from tool input. */
	workspaceId: string
	/** The MCP caller's actor. Telemetry only: Drive is workspace-scoped. */
	actorId: string
	/** Injection point for tests. Defaults to the real fetch-backed client. */
	client?: DriveClient
}

export const GOOGLE_APPS_FOLDER_MIME = 'application/vnd.google-apps.folder'
export const GOOGLE_APPS_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'

/** The per-file fields every listing tool asks Drive for (and nothing more). */
export const FILE_FIELDS =
	'id,name,mimeType,modifiedTime,parents,owners(displayName,emailAddress),webViewLink,shortcutDetails(targetId,targetMimeType)'

export interface DriveFileEntry {
	id: string
	name: string
	mimeType: string
	modifiedTime?: string
	parents?: string[]
	owners?: Array<{ displayName?: string; emailAddress?: string }>
	webViewLink?: string
	/** Set only on shortcut entries: the id of the file the shortcut points at. */
	shortcutTargetId?: string
}

export function toFileEntry(f: DriveApiFile): DriveFileEntry {
	const entry: DriveFileEntry = { id: f.id, name: f.name, mimeType: f.mimeType }
	if (f.modifiedTime !== undefined) entry.modifiedTime = f.modifiedTime
	if (f.parents !== undefined) entry.parents = f.parents
	if (f.owners !== undefined) entry.owners = f.owners
	if (f.webViewLink !== undefined) entry.webViewLink = f.webViewLink
	if (f.mimeType === GOOGLE_APPS_SHORTCUT_MIME && f.shortcutDetails?.targetId) {
		entry.shortcutTargetId = f.shortcutDetails.targetId
	}
	return entry
}

/**
 * Escape a value for use inside a single-quoted Drive query literal. Without
 * this a folder id containing a quote could close the literal and append its
 * own query terms.
 */
export function escapeDriveQueryValue(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export function clampPageSize(
	requested: number | undefined,
	fallback: number,
	max: number,
): number {
	if (requested === undefined) return fallback
	return Math.min(Math.max(1, Math.floor(requested)), max)
}
