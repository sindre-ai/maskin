import { createHash } from 'node:crypto'
import type { Database, Transaction } from '@maskin/db'
import { type CredentialAccessAction, credentialAccessLog } from '@maskin/db/schema'
import { sql } from 'drizzle-orm'

// The audit log is a per-workspace hash chain assigned by the
// credential_access_log_insert() trigger (migration 0087). This file holds the
// pieces that must agree with that trigger byte for byte: the genesis constant,
// the field separator, the field order, and the canonical read_at text.

/** Row one of a workspace chains to this. Matches the trigger's constant. */
export const CREDENTIAL_LOG_GENESIS_HASH = createHash('sha256')
	.update('maskin-credential-access-log-genesis-v1', 'utf8')
	.digest('hex')

// Unit separator, so adjacent fields cannot shift into each other.
const SEP = '\u001f'

/**
 * Role the audit insert runs as. It has INSERT and SELECT on the log and
 * nothing else, so the code path that writes the log cannot alter it.
 */
export const CREDENTIAL_LOG_ROLE = 'maskin_keychain_app'

export interface CredentialLogHashInput {
	prevRowHash: string
	workspaceId: string
	integrationId: string
	actorId: string
	sessionId: string | null
	outboundTarget: string | null
	action: string
	source: string
	requestId: string
	/**
	 * read_at as credential_access_log_ts_text() renders it: UTC, microseconds,
	 * e.g. 2026-10-03T12:00:00.123456Z. Select it from Postgres as text. Never
	 * build it from a JavaScript Date, which keeps milliseconds only and would
	 * make every row fail verification.
	 */
	readAtText: string
}

export function computeRowHash(i: CredentialLogHashInput): string {
	return createHash('sha256')
		.update(
			[
				i.prevRowHash,
				i.workspaceId,
				i.integrationId,
				i.actorId,
				i.sessionId ?? '',
				i.outboundTarget ?? '',
				i.action,
				i.source,
				i.requestId,
				i.readAtText,
			].join(SEP),
			'utf8',
		)
		.digest('hex')
}

export interface CredentialLogEntry {
	workspaceId: string
	integrationId: string
	actorId: string
	sessionId?: string | null
	loopId?: string | null
	outboundTarget?: string | null
	action: CredentialAccessAction
	source: string
	requestId: string
}

/**
 * Appends one row to the chain. Must run inside the transaction that does the
 * work it records, so a read without a log row cannot commit. The trigger owns
 * id, prev_row_hash and row_hash; nothing passed here can set them.
 */
export async function insertCredentialAccessLog(
	tx: Transaction,
	entry: CredentialLogEntry,
): Promise<void> {
	// Drop to the constrained role for the insert only. No try/finally: if the
	// insert fails the transaction is aborted, RESET ROLE would fail too and mask
	// the real error, and the rollback restores the role anyway (SET LOCAL).
	await tx.execute(sql.raw(`SET LOCAL ROLE ${CREDENTIAL_LOG_ROLE}`))
	await tx.insert(credentialAccessLog).values({
		workspaceId: entry.workspaceId,
		integrationId: entry.integrationId,
		actorId: entry.actorId,
		sessionId: entry.sessionId ?? null,
		loopId: entry.loopId ?? null,
		outboundTarget: entry.outboundTarget ?? null,
		action: entry.action,
		source: entry.source,
		requestId: entry.requestId,
	})
	await tx.execute(sql.raw('RESET ROLE'))
}

export type ChainVerification =
	| { ok: true; rows: number; headHash: string | null }
	| { ok: false; rows: number; brokenAtId: string; reason: string }

interface LogRow extends Record<string, unknown> {
	id: string
	workspace_id: string
	integration_id: string
	actor_id: string
	session_id: string | null
	outbound_target: string | null
	action: string
	source: string
	request_id: string
	read_at_text: string
	prev_row_hash: string
	row_hash: string
}

/**
 * Walks a workspace's chain from genesis to head in id order and recomputes
 * every hash. Reads read_at as text through credential_access_log_ts_text() so
 * the hashed value is exactly the microsecond text Postgres hashed on insert.
 * Loads the whole chain: fine for a test or a script, page it before pointing it
 * at a production-sized workspace.
 */
export async function verifyCredentialAccessChain(
	db: Database | Transaction,
	workspaceId: string,
): Promise<ChainVerification> {
	const rows = (await db.execute(sql`
		SELECT id::text AS id, workspace_id::text AS workspace_id, integration_id::text AS integration_id,
			actor_id::text AS actor_id, session_id::text AS session_id, outbound_target, action, source,
			request_id, credential_access_log_ts_text(read_at) AS read_at_text, prev_row_hash, row_hash
		FROM credential_access_log
		WHERE workspace_id = ${workspaceId}
		ORDER BY id
	`)) as unknown as LogRow[]

	let prev = CREDENTIAL_LOG_GENESIS_HASH
	for (const [index, row] of rows.entries()) {
		if (row.prev_row_hash !== prev) {
			return { ok: false, rows: index, brokenAtId: row.id, reason: 'prev_row_hash does not chain' }
		}
		const expected = computeRowHash({
			prevRowHash: row.prev_row_hash,
			workspaceId: row.workspace_id,
			integrationId: row.integration_id,
			actorId: row.actor_id,
			sessionId: row.session_id,
			outboundTarget: row.outbound_target,
			action: row.action,
			source: row.source,
			requestId: row.request_id,
			readAtText: row.read_at_text,
		})
		if (row.row_hash !== expected) {
			return {
				ok: false,
				rows: index,
				brokenAtId: row.id,
				reason: 'row_hash does not match contents',
			}
		}
		prev = row.row_hash
	}
	return { ok: true, rows: rows.length, headHash: rows.length ? prev : null }
}
