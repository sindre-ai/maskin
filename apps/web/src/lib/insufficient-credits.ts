import { ApiError, type InsufficientCreditsContext } from '@/lib/api'
import { getFlag } from '@/lib/feature-flags'

const CREDIT_UX_FLAG = 'maskin-credit-ux'

/**
 * Single owner of the out-of-credits modal's open state.
 *
 * Every session-start call site reports a 402 here instead of toasting, so the
 * presentation lives in one mounted modal rather than one per call site — which
 * would stack duplicates and fire the analytics event once per caller.
 */
let current: InsufficientCreditsContext | null = null
const listeners = new Set<() => void>()

function emit(): void {
	for (const listener of listeners) listener()
}

export function subscribeInsufficientCredits(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export function getInsufficientCreditsPayload(): InsufficientCreditsContext | null {
	return current
}

/**
 * Returns false when the credit UX flag is off, leaving the call site to keep
 * its previous presentation rather than swallowing the error.
 *
 * Stores a fresh object each open: the modal fires its analytics event from an
 * effect keyed on this reference, so reusing one would drop the event on the
 * second open.
 */
export function openInsufficientCreditsModal(payload: InsufficientCreditsContext): boolean {
	if (!getFlag(CREDIT_UX_FLAG)) return false
	current = { ...payload }
	emit()
	return true
}

export function closeInsufficientCreditsModal(): void {
	if (current === null) return
	current = null
	emit()
}

/**
 * The one call a session-start failure needs: opens the modal when the error is
 * the credit gate, and reports whether it took ownership of the presentation.
 */
export function openInsufficientCreditsModalForError(err: unknown): boolean {
	if (!(err instanceof ApiError) || err.code !== 'INSUFFICIENT_CREDITS') return false
	const payload = err.insufficientCreditsContext
	if (!payload) return false
	return openInsufficientCreditsModal(payload)
}

/**
 * Thrown by a send the credit modal has taken over. The composer must treat it
 * as a *failed* send — only a resolved send clears the draft — while rendering
 * no inline failure of its own, because the modal owns the presentation.
 */
export class InsufficientCreditsBlockedError extends Error {
	constructor() {
		super('Workspace balance is below the minimum reserve')
		this.name = 'InsufficientCreditsBlockedError'
	}
}

export function isInsufficientCreditsBlocked(err: unknown): boolean {
	return err instanceof InsufficientCreditsBlockedError
}

export function _resetInsufficientCredits(): void {
	current = null
	listeners.clear()
}
