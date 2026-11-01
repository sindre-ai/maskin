import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { logger } from './logger'

/**
 * How long the route picker leaves the workspace Anthropic API key alone after
 * it failed with "Credit balance is too low". A top-up is a person's job, so
 * there is nothing to gain from retrying every turn; 30 minutes is long enough
 * to stop the pile-up and short enough that a topped-up key is back soon.
 */
export const API_KEY_CREDIT_MARK_WINDOW_MS = 30 * 60 * 1000

/**
 * Where the mark lives: one key on `workspaces.settings`, owned by the server.
 * Deliberately not in the shared settings schema, so no client or OpenAPI type
 * grows a field nobody is meant to set. Settings PATCH merges top-level keys
 * onto the stored row, so it passes through untouched.
 */
const MARK_KEY = 'anthropic_key_out_of_credit'
// The key is a constant, so it is written into the statement as a literal.
const MARK_LITERAL = sql.raw(`'${MARK_KEY}'`)
const MARK_PATH_LITERAL = sql.raw(`'{${MARK_KEY}}'`)

/**
 * `at` is when the credit error was seen (ms). `key` is a hash of the stored
 * key value at that moment. Saving a new key stores a new sealed value, so the
 * hash stops matching and the mark no longer applies: replacing the key clears
 * it without the settings route having to know about it.
 */
export interface ApiKeyCreditMark {
	at: number
	key: string
}

/** Hash of a stored key value (the sealed text, never the plain key). */
export function fingerprintStoredKey(stored: string): string {
	return createHash('sha256').update(stored, 'utf8').digest('hex')
}

function readMark(settings: unknown): ApiKeyCreditMark | null {
	if (!settings || typeof settings !== 'object') return null
	const raw = (settings as Record<string, unknown>)[MARK_KEY]
	if (!raw || typeof raw !== 'object') return null
	const { at, key } = raw as Record<string, unknown>
	if (typeof at !== 'number' || typeof key !== 'string') return null
	return { at, key }
}

/**
 * Whether the stored Anthropic key is inside its out-of-credit window right
 * now. `stale` is a mark that no longer applies (window over, or the key was
 * replaced) and can be removed.
 */
export function checkApiKeyCreditMark(
	settings: unknown,
	storedKey: string,
	now: number = Date.now(),
): { outOfCredit: boolean; stale: ApiKeyCreditMark | null } {
	const mark = readMark(settings)
	if (!mark) return { outOfCredit: false, stale: null }
	const sameKey = mark.key === fingerprintStoredKey(storedKey)
	const inWindow = now - mark.at < API_KEY_CREDIT_MARK_WINDOW_MS
	return sameKey && inWindow
		? { outOfCredit: true, stale: null }
		: { outOfCredit: false, stale: mark }
}

/**
 * Marks the workspace's stored Anthropic key as out of credit. One statement
 * that sets one settings field, so a settings edit made at the same moment is
 * not overwritten (no read-modify-write of the settings object). The key's
 * hash is taken inside the same statement, so the mark always matches the key
 * that is stored when it is written. Does nothing when no key is stored.
 * Never throws: the caller is a failure path that has more important work.
 */
export async function markApiKeyOutOfCredit(params: {
	db: Database
	workspaceId: string
	now?: number
}): Promise<boolean> {
	const { db, workspaceId, now = Date.now() } = params
	try {
		const rows = await db
			.update(workspaces)
			.set({
				settings: sql`jsonb_set(${workspaces.settings}, ${MARK_PATH_LITERAL}, jsonb_build_object('at', ${now}::bigint, 'key', encode(sha256(convert_to(${workspaces.settings}->'llm_keys'->>'anthropic', 'UTF8')), 'hex')), true)`,
			})
			.where(
				and(
					eq(workspaces.id, workspaceId),
					sql`${workspaces.settings}->'llm_keys'->>'anthropic' IS NOT NULL`,
				),
			)
			.returning({ id: workspaces.id })
		if (rows.length > 0) {
			logger.warn('Workspace Anthropic API key marked out of credit', {
				workspaceId,
				windowMs: API_KEY_CREDIT_MARK_WINDOW_MS,
			})
		}
		return rows.length > 0
	} catch (err) {
		logger.warn('Could not mark the workspace Anthropic API key out of credit', {
			workspaceId,
			error: String(err),
		})
		return false
	}
}

/**
 * Removes a mark that no longer applies. Matches on the mark's own timestamp,
 * so a fresh mark written a moment ago is left alone. Best-effort; a mark that
 * lingers is harmless because {@link checkApiKeyCreditMark} ignores it anyway.
 */
export async function clearStaleApiKeyCreditMark(params: {
	db: Database
	workspaceId: string
	mark: ApiKeyCreditMark
}): Promise<void> {
	const { db, workspaceId, mark } = params
	try {
		await db
			.update(workspaces)
			.set({ settings: sql`${workspaces.settings} - ${MARK_LITERAL}` })
			.where(
				and(
					eq(workspaces.id, workspaceId),
					sql`(${workspaces.settings}->${MARK_LITERAL}->>'at') = ${String(mark.at)}`,
				),
			)
	} catch (err) {
		logger.warn('Could not clear a stale out-of-credit mark', {
			workspaceId,
			error: String(err),
		})
	}
}
