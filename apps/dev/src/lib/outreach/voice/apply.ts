import type { Database, Transaction } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { recordEvent } from '../../events/record-event'
import { type EffectContext, type EffectRunner, runEffects } from './effects'
import { type ToolTraceEntry, type VoiceEffect, type VoiceEvent, advance } from './state'

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
			/** The contact's metadata after this event (unchanged when not applied). */
			metadata: Record<string, unknown>
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
				metadata: current ?? {},
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
			metadata,
			effects: result.effects,
			effectContext,
		} as const
	})
}

export type ToolRecordOutcome = 'recorded' | 'duplicate' | 'stale_call' | 'not_found'

export interface RecordToolSuccessParams {
	workspaceId: string
	contactId: string
	callId: string
	toolName: string
	/** Merged into contact.metadata in the same write. null deletes the key. */
	metadata?: Record<string, unknown>
	/** Written as an event on the contact in the same transaction as the trace entry. */
	audit?: { action: string; data: Record<string, unknown> }
}

/**
 * The single writer for the trace the reducer reads when the call hangs up. The tool router
 * calls it after a tool succeeded, never before: a tool that failed leaves no entry, so a
 * failed confirm_meeting_slot cannot resolve the call to voice_meeting_booked.
 *
 * The trace belongs to one call (the reducer clears it when the call starts), so an entry for
 * the tool name already in it means this call already recorded the tool: a replay adds no second
 * entry and no second audit event. The metadata patch is still applied. Does not touch status.
 */
export async function recordToolSuccess(
	db: VoiceDb,
	params: RecordToolSuccessParams,
): Promise<ToolRecordOutcome> {
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
		if (!row) return 'not_found'
		const metadata = (row.metadata ?? {}) as Record<string, unknown>
		// A trace belongs to the call it was started on.
		if (typeof metadata.last_call_id === 'string' && metadata.last_call_id !== params.callId) {
			return 'stale_call'
		}
		const trace = Array.isArray(metadata.voice_tool_trace) ? metadata.voice_tool_trace : []
		const seen = trace.some(
			(e) =>
				typeof e === 'object' && e !== null && (e as ToolTraceEntry).tool_name === params.toolName,
		)
		const next = mergeMetadata(metadata, params.metadata ?? {})
		if (!seen) next.voice_tool_trace = [...trace, { tool_name: params.toolName }]
		await tx
			.update(objects)
			.set({ metadata: next, updatedAt: new Date() })
			.where(eq(objects.id, row.id))
		if (!seen && params.audit) {
			await recordEvent(tx, {
				workspaceId: params.workspaceId,
				actorId: row.driver ?? row.createdBy,
				action: params.audit.action,
				entityType: 'object',
				entityId: row.id,
				data: params.audit.data,
			})
		}
		return seen ? 'duplicate' : 'recorded'
	})
}

export async function runAppliedEffects(
	result: Extract<ApplyVoiceEventResult, { found: true }>,
	runner: EffectRunner,
): Promise<void> {
	await runEffects(result.effects, result.effectContext, runner)
}

/**
 * Merges a patch into the metadata of the contact's current call, without a trace entry. Used by
 * tools that failed but still leave a hint behind (followup_action after a Calendar failure).
 */
export async function patchContactMetadata(
	db: VoiceDb,
	params: {
		workspaceId: string
		contactId: string
		callId: string
		patch: Record<string, unknown>
	},
): Promise<ToolRecordOutcome> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({ id: objects.id, metadata: objects.metadata })
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
		if (!row) return 'not_found'
		const metadata = (row.metadata ?? {}) as Record<string, unknown>
		if (typeof metadata.last_call_id === 'string' && metadata.last_call_id !== params.callId) {
			return 'stale_call'
		}
		await tx
			.update(objects)
			.set({ metadata: mergeMetadata(metadata, params.patch), updatedAt: new Date() })
			.where(eq(objects.id, row.id))
		return 'recorded'
	})
}
