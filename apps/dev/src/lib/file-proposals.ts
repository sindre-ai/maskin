import type { fileProposalChanges } from '@maskin/db/schema'
import type { FileProposalChangeDto, ProposedChange } from '@maskin/shared'

/** Characters of the file kept on each side of old_text, taken when a proposal is submitted. */
export const PROPOSAL_CONTEXT_CHARS = 40

export interface ResolvedChange {
	index: number
	start: number
	end: number
	contextBefore: string
	contextAfter: string
}

export type ProposalValidation =
	| { ok: true; resolved: ResolvedChange[] }
	| { ok: false; index: number; message: string }

/** How many times needle occurs in source, counting overlapping occurrences. */
export function countOccurrences(source: string, needle: string): number {
	if (needle.length === 0) return 0
	let count = 0
	let from = 0
	while (true) {
		const at = source.indexOf(needle, from)
		if (at === -1) return count
		count++
		from = at + 1
	}
}

/**
 * A change is stale when its old_text no longer occurs exactly once in the
 * file's current bytes. Computed on every read; never stored.
 */
export function isChangeStale(source: string, oldText: string): boolean {
	return countOccurrences(source, oldText) !== 1
}

// Slicing by UTF-16 unit can cut a surrogate pair in half; step off the pair.
function isLowSurrogate(source: string, at: number): boolean {
	const code = source.charCodeAt(at)
	return code >= 0xdc00 && code <= 0xdfff
}

function contextAround(source: string, start: number, end: number) {
	let from = Math.max(0, start - PROPOSAL_CONTEXT_CHARS)
	if (from > 0 && isLowSurrogate(source, from)) from++
	let to = Math.min(source.length, end + PROPOSAL_CONTEXT_CHARS)
	if (to < source.length && isLowSurrogate(source, to)) to--
	return { contextBefore: source.slice(from, start), contextAfter: source.slice(end, to) }
}

/**
 * Match every change's old_text against the raw markdown source. Each must
 * match exactly once and no two changes may overlap; the first problem found
 * rejects the whole submit and names the change by its position in the input.
 */
export function validateProposedChanges(
	source: string,
	changes: ProposedChange[],
): ProposalValidation {
	const resolved: ResolvedChange[] = []

	for (const [index, change] of changes.entries()) {
		const matches = countOccurrences(source, change.old_text)
		if (matches === 0) {
			return {
				ok: false,
				index,
				message: 'old_text was not found in the file, check it matches the current text exactly',
			}
		}
		if (matches > 1) {
			return {
				ok: false,
				index,
				message: `old_text matches ${matches} times, include more surrounding text`,
			}
		}
		const start = source.indexOf(change.old_text)
		const end = start + change.old_text.length
		resolved.push({ index, start, end, ...contextAround(source, start, end) })
	}

	const byStart = [...resolved].sort((a, b) => a.start - b.start)
	for (let i = 1; i < byStart.length; i++) {
		const prev = byStart[i - 1] as ResolvedChange
		const next = byStart[i] as ResolvedChange
		if (next.start < prev.end) {
			// Name the later change in the input, so the agent fixes the one it wrote second.
			const index = Math.max(prev.index, next.index)
			const other = Math.min(prev.index, next.index)
			return { ok: false, index, message: `old_text overlaps the text of change ${other}` }
		}
	}

	return { ok: true, resolved }
}

/** A change row as the API returns it. Only a pending change can be stale; a decided one is settled. */
export function toChangeDto(
	ch: typeof fileProposalChanges.$inferSelect,
	source: string | null,
): FileProposalChangeDto {
	return {
		id: ch.id,
		ordinal: ch.ordinal,
		oldText: ch.oldText,
		newText: ch.newText,
		reason: ch.reason,
		contextBefore: ch.contextBefore,
		contextAfter: ch.contextAfter,
		status: ch.status as 'pending' | 'accepted' | 'rejected',
		decidedBy: ch.decidedBy,
		decidedAt: ch.decidedAt ? ch.decidedAt.toISOString() : null,
		appliedText: ch.appliedText,
		stale: ch.status === 'pending' && source !== null && isChangeStale(source, ch.oldText),
	}
}
