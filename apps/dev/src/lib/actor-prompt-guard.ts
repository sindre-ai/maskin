import { trackSystemPromptCorruptionPrevented } from './analytics/actor-prompt-events'
import { Sentry } from './sentry'

export type PromptGuardWritePath =
	| 'patch_actor'
	| 'loop_version_pusher_locked_install'
	| 'loop_version_pusher_dedup'

export type PromptGuardCause = 'null_write' | 'empty_write' | 'shrink_to_zero'

export interface PromptGuardCtx {
	writePath: PromptGuardWritePath
	writerActorId?: string
	actorId: string
	workspaceId: string
}

export interface PromptGuardResult {
	ok: boolean
	cause?: PromptGuardCause
	writePath: PromptGuardWritePath
	writerActorId?: string
	previousLength: number
	attemptedLength: number
}

// Rule: if `previous` has content (length > 0 after trim) AND `attempted` is
// null / undefined / empty-after-trim, reject the write and emit observability.
// Otherwise the caller writes the value verbatim. Fails-closed: never throws.
export function guardSystemPromptWrite(
	previous: string | null,
	attempted: string | null | undefined,
	ctx: PromptGuardCtx,
): PromptGuardResult {
	const previousStr = previous ?? ''
	const previousTrimmed = previousStr.trim()
	const previousLength = previousStr.length

	const attemptedStr = attempted ?? ''
	const attemptedTrimmed = attemptedStr.trim()
	const attemptedLength = attemptedStr.length

	const previousHasContent = previousTrimmed.length > 0

	if (!previousHasContent) {
		return {
			ok: true,
			writePath: ctx.writePath,
			writerActorId: ctx.writerActorId,
			previousLength,
			attemptedLength,
		}
	}

	let cause: PromptGuardCause | null = null
	if (attempted === null || attempted === undefined) {
		cause = 'null_write'
	} else if (attemptedTrimmed.length === 0) {
		cause = 'empty_write'
	}

	if (!cause) {
		return {
			ok: true,
			writePath: ctx.writePath,
			writerActorId: ctx.writerActorId,
			previousLength,
			attemptedLength,
		}
	}

	// Direct Sentry.captureMessage — logger.warn only adds a breadcrumb and does
	// NOT create a Sentry issue, so the 7-day-silent Won condition on the bet
	// cannot be observed through logger alone.
	try {
		Sentry.captureMessage('system_prompt_corruption_prevented', {
			level: 'warning',
			extra: {
				cause,
				writePath: ctx.writePath,
				writerActorId: ctx.writerActorId,
				actorId: ctx.actorId,
				workspaceId: ctx.workspaceId,
				previousLength,
				attemptedLength,
			},
		})
	} catch {
		// captureMessage is safe on uninitialised Sentry, but never let a mock's
		// throw take out the caller.
	}

	// Best-effort PostHog emit, behind POSTHOG_SYSTEM_PROMPT_EVENT=true. Never
	// awaited from the guard's return — the guard is synchronous.
	void trackSystemPromptCorruptionPrevented({
		cause,
		writePath: ctx.writePath,
		writerActorId: ctx.writerActorId,
		actorId: ctx.actorId,
		workspaceId: ctx.workspaceId,
		previousLength,
		attemptedLength,
	})

	return {
		ok: false,
		cause,
		writePath: ctx.writePath,
		writerActorId: ctx.writerActorId,
		previousLength,
		attemptedLength,
	}
}
