import type { Database, Transaction } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { recordEvent } from '../../events/record-event'
import { type EffectContext, type EffectRunner, runEffects } from './effects'
import { type VoiceEffect, type VoiceEvent, advance } from './state'

export interface ApplyVoiceEventParams {
	workspaceId: string
	contactId: string
	event: VoiceEvent
	now?: Date
}

export type ApplyVoiceEventResult =
	| { found: false }
	| {
			found: true
			applied: boolean
			/** The event named a call other than the contact's current one. */
			staleCall: boolean
			previousStatus: string
			status: string
			effects: VoiceEffect[]
			effectContext: EffectContext
	  }

function mergeMetadata(
	current: Record<string, unknown> | null,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...(current ?? {}) }
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) delete next[k]
		else next[k] = v
	}
	return next
}

/**
 * Loads the contact under a row lock, runs advance(), and persists the result
 * with an audit event. This is the only code path that writes a contact's voice
 * status. Side effects are returned, not run, so the caller can run them after
 * the transaction commits.
 */
/** A top-level connection or an open transaction (then this nests as a savepoint). */
export type VoiceDb = Database | Transaction

export async function applyVoiceEvent(
	db: VoiceDb,
	params: ApplyVoiceEventParams,
): Promise<ApplyVoiceEventResult> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(objects)
			.where(
				and(
					eq(objects.id, params.contactId),
					eq(objects.workspaceId, params.workspaceId),
					eq(objects.type, 'contact'),
				),
			)
			.for('update')
			.limit(1)
		if (!row) return { found: false } as const

		const current = (row.metadata ?? null) as Record<string, unknown> | null
		const result = advance({ status: row.status, metadata: current }, params.event, params.now)
		const actorId = row.driver ?? row.createdBy
		const dialAttemptN = Number(
			(mergeMetadata(current, result.metadata).dial_attempt_n as number | undefined) ?? 0,
		)
		const effectContext: EffectContext = {
			workspaceId: params.workspaceId,
			contactId: params.contactId,
			actorId,
			dialAttemptN,
		}

		if (!result.applied) {
			return {
				found: true,
				applied: false,
				staleCall: result.staleCall,
				previousStatus: row.status,
				status: row.status,
				effects: [],
				effectContext,
			} as const
		}

		const metadata = mergeMetadata(current, result.metadata)
		await tx
			.update(objects)
			.set({ status: result.status, metadata, updatedAt: new Date() })
			.where(eq(objects.id, row.id))

		await recordEvent(tx, {
			workspaceId: params.workspaceId,
			actorId,
			action: result.status !== row.status ? 'status_changed' : 'updated',
			entityType: 'object',
			entityId: row.id,
			data: {
				source: 'telnyx_webhook',
				voice_event: params.event.type,
				fromStatus: row.status,
				toStatus: result.status,
			},
		})

		return {
			found: true,
			applied: true,
			staleCall: result.staleCall,
			previousStatus: row.status,
			status: result.status,
			effects: result.effects,
			effectContext,
		} as const
	})
}

export interface RecordToolCallParams {
	workspaceId: string
	contactId: string
	callId: string
	/** Appended to voice_tool_trace. null patches metadata only (a failed call leaves no trace). */
	toolName: string | null
	/** Merged into contact metadata in the same write (null deletes a key). */
	metadataPatch?: Record<string, unknown>
	/** Telnyx retries a tool invocation: do nothing when this tool is already in this call's trace. */
	once?: boolean
	/** Runs in the same transaction after the write (audit events), with the row as written. */
	inTransaction?: (tx: VoiceDb, contact: RecordedContact) => Promise<void>
}

export interface RecordedContact {
	id: string
	title: string
	metadata: Record<string, unknown>
	actorId: string
}

export type RecordToolCallResult =
	| { recorded: true; contact: RecordedContact }
	| { recorded: false; reason: 'contact_not_found' | 'stale_call' | 'duplicate' }

/** metadata = (metadata minus the null-valued keys) merged with the rest, as one atomic jsonb expression. */
function metadataMergeSql(patch: Record<string, unknown>) {
	const set: Record<string, unknown> = {}
	const remove: string[] = []
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) remove.push(k)
		else set[k] = v
	}
	const removeKeys =
		remove.length > 0
			? sql`ARRAY[${sql.join(
					remove.map((k) => sql`${k}`),
					sql`, `,
				)}]::text[]`
			: sql`ARRAY[]::text[]`
	return sql`(coalesce(${objects.metadata}, '{}'::jsonb) - ${removeKeys}) || ${JSON.stringify(set)}::jsonb`
}

/** Merges a patch into a contact's metadata (null deletes a key) without reading it first. */
export async function mergeContactMetadata(
	db: VoiceDb,
	params: { workspaceId: string; contactId: string; patch: Record<string, unknown> },
): Promise<void> {
	await db
		.update(objects)
		.set({ metadata: metadataMergeSql(params.patch) })
		.where(
			and(
				eq(objects.id, params.contactId),
				eq(objects.workspaceId, params.workspaceId),
				eq(objects.type, 'contact'),
			),
		)
}

/**
 * The one writer of a call's tool trace. Locks the contact row, checks the stale-call and
 * duplicate guards against what is stored, then writes the trace entry and the metadata patch
 * as one atomic jsonb merge (not a read-modify-write of the whole object), so another writer's
 * keys survive. The caller's audit write runs in the same transaction. Does not touch status.
 */
export async function recordToolCall(
	db: VoiceDb,
	params: RecordToolCallParams,
): Promise<RecordToolCallResult> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(objects)
			.where(
				and(
					eq(objects.id, params.contactId),
					eq(objects.workspaceId, params.workspaceId),
					eq(objects.type, 'contact'),
				),
			)
			.for('update')
			.limit(1)
		if (!row) return { recorded: false, reason: 'contact_not_found' } as const
		const current = (row.metadata ?? {}) as Record<string, unknown>
		// A trace belongs to the call it was started on.
		if (typeof current.last_call_id === 'string' && current.last_call_id !== params.callId) {
			return { recorded: false, reason: 'stale_call' } as const
		}
		const trace = Array.isArray(current.voice_tool_trace) ? current.voice_tool_trace : []
		if (
			params.once &&
			params.toolName !== null &&
			trace.some((e) => (e as { tool_name?: unknown } | null)?.tool_name === params.toolName)
		) {
			return { recorded: false, reason: 'duplicate' } as const
		}

		let next = metadataMergeSql(params.metadataPatch ?? {})
		if (params.toolName !== null) {
			next = sql`jsonb_set(${next}, '{voice_tool_trace}', coalesce(${objects.metadata} -> 'voice_tool_trace', '[]'::jsonb) || ${JSON.stringify([{ tool_name: params.toolName }])}::jsonb)`
		}
		const [written] = await tx
			.update(objects)
			.set({ metadata: next })
			.where(eq(objects.id, row.id))
			.returning({ metadata: objects.metadata })
		const contact: RecordedContact = {
			id: row.id,
			title: row.title ?? '',
			metadata: (written?.metadata ?? {}) as Record<string, unknown>,
			actorId: row.driver ?? row.createdBy,
		}
		await params.inTransaction?.(tx, contact)
		return { recorded: true, contact } as const
	})
}

export async function runAppliedEffects(
	result: Extract<ApplyVoiceEventResult, { found: true }>,
	runner: EffectRunner,
): Promise<void> {
	await runEffects(result.effects, result.effectContext, runner)
}
