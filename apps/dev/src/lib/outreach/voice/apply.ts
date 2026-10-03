import type { Database, Transaction } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
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

/** Appends a tool call to the trace the reducer reads when the call hangs up. Does not touch status. */
export async function recordToolInvocation(
	db: VoiceDb,
	params: { workspaceId: string; contactId: string; callId: string; toolName: string },
): Promise<void> {
	await db.transaction(async (tx) => {
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
		if (!row) return
		const metadata = (row.metadata ?? {}) as Record<string, unknown>
		// A trace belongs to the call it was started on.
		if (typeof metadata.last_call_id === 'string' && metadata.last_call_id !== params.callId) return
		const trace = Array.isArray(metadata.voice_tool_trace) ? metadata.voice_tool_trace : []
		await tx
			.update(objects)
			.set({
				metadata: {
					...metadata,
					voice_tool_trace: [...trace, { tool_name: params.toolName }],
				},
			})
			.where(eq(objects.id, row.id))
	})
}

export async function runAppliedEffects(
	result: Extract<ApplyVoiceEventResult, { found: true }>,
	runner: EffectRunner,
): Promise<void> {
	await runEffects(result.effects, result.effectContext, runner)
}
