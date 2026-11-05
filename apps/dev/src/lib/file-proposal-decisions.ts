import { fileProposalChanges } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { countOccurrences } from './file-proposals'
import { type SaveFileDeps, saveFile } from './file-save'

export type ProposalChangeRow = typeof fileProposalChanges.$inferSelect

/** Some changes no longer match the file exactly once. Nothing was written. */
export class ChangesStaleError extends Error {
	constructor(readonly changeIds: string[]) {
		super('Some changes no longer match the file')
		this.name = 'ChangesStaleError'
	}
}

/** Some changes were already accepted or rejected, or are gone. Nothing was changed. */
export class ChangesAlreadyDecidedError extends Error {
	constructor(readonly changeIds: string[]) {
		super('Some changes were already decided')
		this.name = 'ChangesAlreadyDecidedError'
	}
}

export interface AcceptInput {
	fileId: string
	proposalId: string
	deciderId: string
	/** appliedText is what to write instead of the proposed new_text. */
	items: { changeId: string; appliedText?: string }[]
}

export interface AcceptResult {
	/** The accepted changes, with appliedText set to what was written. */
	changes: ProposalChangeRow[]
	contentChanged: boolean
}

interface Edit {
	id: string
	start: number
	end: number
	text: string
}

/**
 * Applies accepted changes to the file's text. Every old_text must match exactly
 * once in the text as it is now; the matches are found in the text before any
 * edit, so one edit cannot shift or create another's match. A change that
 * fails that, or overlaps one before it, is stale.
 */
function applyEdits(
	source: string,
	rows: ProposalChangeRow[],
	appliedText: Map<string, string>,
): string {
	const stale: string[] = []
	const edits: Edit[] = []
	for (const row of rows) {
		if (countOccurrences(source, row.oldText) !== 1) {
			stale.push(row.id)
			continue
		}
		const start = source.indexOf(row.oldText)
		edits.push({
			id: row.id,
			start,
			end: start + row.oldText.length,
			text: appliedText.get(row.id) ?? row.newText,
		})
	}

	edits.sort((a, b) => a.start - b.start)
	const kept: Edit[] = []
	for (const edit of edits) {
		const prev = kept[kept.length - 1]
		if (prev && edit.start < prev.end) stale.push(edit.id)
		else kept.push(edit)
	}
	if (stale.length > 0) throw new ChangesStaleError(stale)

	let result = source
	for (const edit of kept.reverse()) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
	}
	return result
}

/**
 * Accepts changes of one proposal, all or nothing, through saveFile so the
 * write follows the same rules as every other file save: row lock, upload while
 * holding the lock, new hash on the row, then commit. Inside that one
 * transaction the changes are re-read and re-matched against the bytes stored
 * right now, and marked accepted. A stale or already-decided change aborts the
 * whole save. If the commit fails after the upload, saveFile puts the old bytes
 * back.
 *
 * The row lock only stops two accepts from racing each other. What keeps an
 * agent write or editor autosave from landing in between is the three of them
 * together: upload while holding the lock, the stored hash, and if_match.
 *
 * Returns null when the file does not exist.
 */
export async function acceptProposalChanges(
	deps: SaveFileDeps,
	input: AcceptInput,
): Promise<AcceptResult | null> {
	const ids = input.items.map((i) => i.changeId)
	const appliedText = new Map<string, string>()
	for (const item of input.items) {
		if (item.appliedText !== undefined) appliedText.set(item.changeId, item.appliedText)
	}
	// What each change proposed, read under the lock, so applied_text is always what was written.
	const proposed = new Map<string, string>()
	const accepted: ProposalChangeRow[] = []

	const saved = await saveFile(deps, {
		fileId: input.fileId,
		newBytes: null,
		buildBytes: async (current, tx) => {
			const rows = await tx
				.select()
				.from(fileProposalChanges)
				.where(
					and(
						eq(fileProposalChanges.proposalId, input.proposalId),
						inArray(fileProposalChanges.id, ids),
					),
				)
				.orderBy(fileProposalChanges.ordinal)
			const pending = new Set(rows.filter((r) => r.status === 'pending').map((r) => r.id))
			const notPending = ids.filter((id) => !pending.has(id))
			if (notPending.length > 0) throw new ChangesAlreadyDecidedError(notPending)
			for (const row of rows) proposed.set(row.id, row.newText)
			return Buffer.from(applyEdits(current.toString('utf8'), rows, appliedText), 'utf8')
		},
		inTransaction: async (tx) => {
			const decidedAt = new Date()
			for (const item of input.items) {
				// Conditional on pending, so a reject that committed after the read
				// above makes this fail and the whole accept roll back.
				const [row] = await tx
					.update(fileProposalChanges)
					.set({
						status: 'accepted',
						decidedBy: input.deciderId,
						decidedAt,
						appliedText: item.appliedText ?? proposed.get(item.changeId) ?? null,
					})
					.where(
						and(
							eq(fileProposalChanges.id, item.changeId),
							eq(fileProposalChanges.status, 'pending'),
						),
					)
					.returning()
				if (!row) throw new ChangesAlreadyDecidedError([item.changeId])
				accepted.push(row)
			}
		},
	})
	if (!saved) return null
	return { changes: accepted, contentChanged: saved.contentChanged }
}

export interface RejectInput {
	proposalId: string
	deciderId: string
	changeIds: string[]
}

/** Rejects changes of one proposal, all or nothing. Stale changes can be rejected. */
export async function rejectProposalChanges(
	db: SaveFileDeps['db'],
	input: RejectInput,
): Promise<ProposalChangeRow[]> {
	return db.transaction(async (tx) => {
		const rows = await tx
			.update(fileProposalChanges)
			.set({ status: 'rejected', decidedBy: input.deciderId, decidedAt: new Date() })
			.where(
				and(
					eq(fileProposalChanges.proposalId, input.proposalId),
					inArray(fileProposalChanges.id, input.changeIds),
					eq(fileProposalChanges.status, 'pending'),
				),
			)
			.returning()
		const done = new Set(rows.map((r) => r.id))
		const missed = input.changeIds.filter((id) => !done.has(id))
		if (missed.length > 0) throw new ChangesAlreadyDecidedError(missed)
		return rows
	})
}
