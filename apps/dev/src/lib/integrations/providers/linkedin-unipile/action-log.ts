import type { Database } from '@maskin/db'
import { linkedinActions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { trackLinkedInToolCalled } from '../../../analytics/linkedin-events'
import { logger } from '../../../logger'
import { type CapSpec, checkCap, lockCap } from './caps'
import {
	type LinkedInErrorCode,
	LinkedInIntegrationError,
	isLinkedInIntegrationError,
} from './errors'

/**
 * The permanent LinkedIn action log: every call to a LinkedIn MCP tool, old and new, writes
 * exactly one `linkedin_actions` row through `withActionLog`, and fires one generic
 * `linkedin_tool_called` event. The row is the source for the daily caps (caps.ts), the
 * per-person rules and the outreach measurement; the event is for adoption only.
 *
 * Neither carries content. A row holds opaque provider ids (`target_provider_id`, `ref_id`), the
 * approved object and approval ids for sends, the outcome and an error code, and, for InMail
 * only, the credit counts. Never message or post text, names or file contents; the event
 * carries even less (see lib/analytics/linkedin-events.ts). Neither is flaggable: with no
 * content they are safe for every workspace.
 *
 * Life of a row: inserted `pending` before the call (inside the cap transaction when the call
 * has a cap), moved to its final outcome after it. If recording itself fails the tool call
 * still runs and the failure is logged: a missing log row is better than a LinkedIn action
 * that never happens because the log was down.
 */

export type LinkedInToolKind = 'read' | 'write' | 'send'

export type ActionOutcome =
	| 'pending'
	| 'ok'
	| 'noop'
	| 'refused_cap'
	| 'refused_rule'
	| 'refused_flag'
	| 'error'

export type RefusalOutcome = 'refused_cap' | 'refused_rule' | 'refused_flag'

/**
 * Thrown (by the wrapper for a cap, by a handler for a rule or the flag) to refuse a call with
 * nothing sent. It is a LinkedInIntegrationError, so `toolError` shows the agent its code and
 * message; the extra `outcome` is what the log records.
 */
export class LinkedInActionRefusal extends LinkedInIntegrationError {
	readonly outcome: RefusalOutcome

	constructor(outcome: RefusalOutcome, code: LinkedInErrorCode, message: string) {
		super(code, message)
		this.name = 'LinkedInActionRefusal'
		this.outcome = outcome
	}
}

export interface ActionLogContext {
	db: Database
	workspaceId: string
	actorId: string
	/** The connected account row (integrations.id). Caps and dedupe key on this. */
	integrationId: string
	identityType: 'personal' | 'company_page'
	/** The Maskin session that made the call, from X-Maskin-Session-Id. Event only. */
	sessionId?: string | null
	/** Test seam for the cap window. */
	now?: () => Date
}

export interface ActionSpec {
	/** The verb, e.g. `send_message`. */
	tool: string
	kind: LinkedInToolKind
	/** Person or company acted on or read, when known before the call. */
	targetProviderId?: string | null
	cap?: CapSpec
}

export interface ActionFields {
	targetProviderId?: string | null
	/** invitation_id, post_id, comment_id or message_id. Only for tools that act once per id. */
	refId?: string | null
	objectId?: string | null
	approvalId?: string | null
	/** InMail only: credits_before and credits_after. Nothing else may go here. */
	data?: { credits_before?: number | null; credits_after?: number | null } | null
}

export interface ActionRecorder {
	/** Fill in what the call learned (the target from a result, the ref id, the approval). */
	set(fields: ActionFields): void
	/** The call succeeded but changed nothing because it was already done. */
	markNoop(): void
}

const MAX_ID_LENGTH = 255

/** Ids are opaque provider strings; cap the length so an odd input cannot bloat the log. */
function clipId(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed.slice(0, MAX_ID_LENGTH) : null
}

function isUniqueViolation(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false
	const rec = err as Record<string, unknown>
	if (rec.code === '23505') return true
	const cause = rec.cause as Record<string, unknown> | undefined
	return !!cause && cause.code === '23505'
}

type Begun = { rowId: string | null }

async function begin(ctx: ActionLogContext, spec: ActionSpec): Promise<Begun> {
	const base = {
		workspaceId: ctx.workspaceId,
		integrationId: ctx.integrationId,
		actorId: ctx.actorId,
		tool: spec.tool,
		kind: spec.kind,
		targetProviderId: clipId(spec.targetProviderId),
	}
	const cap = spec.cap
	if (!cap) {
		try {
			const [row] = await ctx.db
				.insert(linkedinActions)
				.values({ ...base, outcome: 'pending' })
				.returning({ id: linkedinActions.id })
			return { rowId: row?.id ?? null }
		} catch (err) {
			logger.error('linkedin_actions insert failed', {
				tool: spec.tool,
				error: err instanceof Error ? err.message : String(err),
			})
			return { rowId: null }
		}
	}

	// A call with a cap must not run when the cap cannot be checked, so a database error here
	// propagates instead of being swallowed.
	const now = (ctx.now ?? (() => new Date()))()
	const decision = await ctx.db.transaction(async (tx) => {
		await lockCap(tx, ctx.integrationId, cap.name)
		const usage = await checkCap(tx, ctx.integrationId, cap, now)
		if (!usage.within) {
			await tx.insert(linkedinActions).values({
				...base,
				outcome: 'refused_cap',
				errorCode: 'RATE_LIMITED_LINKEDIN',
			})
			return { refused: true as const, resetAt: usage.resetAt }
		}
		const [row] = await tx
			.insert(linkedinActions)
			.values({ ...base, outcome: 'pending' })
			.returning({ id: linkedinActions.id })
		return { refused: false as const, rowId: row?.id ?? null }
	})
	if (decision.refused) {
		void emit(ctx, spec, 'refused_cap', 'RATE_LIMITED_LINKEDIN')
		throw new LinkedInActionRefusal(
			'refused_cap',
			'RATE_LIMITED_LINKEDIN',
			`Daily limit reached for ${cap.name} on this LinkedIn account (${cap.limit} per rolling 24 hours). Nothing was sent. A slot frees up at ${decision.resetAt.toISOString()}.`,
		)
	}
	return { rowId: decision.rowId }
}

async function finalize(
	ctx: ActionLogContext,
	spec: ActionSpec,
	rowId: string | null,
	outcome: ActionOutcome,
	errorCode: string | null,
	fields: ActionFields,
): Promise<ActionOutcome> {
	if (!rowId) return outcome
	const set = {
		outcome,
		errorCode,
		...(fields.targetProviderId !== undefined
			? { targetProviderId: clipId(fields.targetProviderId) }
			: {}),
		refId: clipId(fields.refId),
		objectId: fields.objectId ?? null,
		approvalId: clipId(fields.approvalId),
		data: fields.data ?? null,
	}
	try {
		await ctx.db.update(linkedinActions).set(set).where(eq(linkedinActions.id, rowId))
		return outcome
	} catch (err) {
		// The unique index allows one `ok` row per (account, tool, ref_id). A second `ok` for the
		// same ref means the work was already done, which is what `noop` says.
		if (outcome === 'ok' && isUniqueViolation(err)) {
			try {
				await ctx.db
					.update(linkedinActions)
					.set({ ...set, outcome: 'noop' })
					.where(eq(linkedinActions.id, rowId))
				return 'noop'
			} catch (retryErr) {
				logger.error('linkedin_actions finalize failed', {
					tool: spec.tool,
					error: retryErr instanceof Error ? retryErr.message : String(retryErr),
				})
				return 'noop'
			}
		}
		logger.error('linkedin_actions finalize failed', {
			tool: spec.tool,
			error: err instanceof Error ? err.message : String(err),
		})
		return outcome
	}
}

function emit(
	ctx: ActionLogContext,
	spec: ActionSpec,
	outcome: ActionOutcome,
	errorCode: string | null,
): Promise<void> {
	return trackLinkedInToolCalled({
		tool: spec.tool,
		kind: spec.kind,
		outcome,
		errorCode,
		actorId: ctx.actorId,
		sessionId: ctx.sessionId ?? null,
		identityType: ctx.identityType,
	})
}

/**
 * Runs one LinkedIn tool call and records it. `run` gets a recorder to add what it learns
 * (target from a result, ref id, approval); whatever `run` returns or throws is passed through
 * untouched, after the row is finalised. A cap hit throws a LinkedInActionRefusal before `run`.
 */
export async function withActionLog<T>(
	ctx: ActionLogContext,
	spec: ActionSpec,
	run: (recorder: ActionRecorder) => Promise<T>,
): Promise<T> {
	const { rowId } = await begin(ctx, spec)
	const fields: ActionFields = {}
	let noop = false
	const recorder: ActionRecorder = {
		set(next) {
			Object.assign(fields, next)
		},
		markNoop() {
			noop = true
		},
	}

	let result: T
	try {
		result = await run(recorder)
	} catch (err) {
		let outcome: ActionOutcome = 'error'
		let errorCode: string = 'LINKEDIN_UNAVAILABLE'
		if (err instanceof LinkedInActionRefusal) {
			outcome = err.outcome
			errorCode = err.code
		} else if (isLinkedInIntegrationError(err)) {
			errorCode = err.code
		}
		const final = await finalize(ctx, spec, rowId, outcome, errorCode, fields)
		void emit(ctx, spec, final, errorCode)
		throw err
	}
	const final = await finalize(ctx, spec, rowId, noop ? 'noop' : 'ok', null, fields)
	void emit(ctx, spec, final, null)
	return result
}
