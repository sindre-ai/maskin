import type { Database } from '@maskin/db'
import { conversationBranches, conversations, messages } from '@maskin/db/schema'
import { type SQL, and, eq, inArray, isNotNull, isNull, min, not, or, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'

// ── Conversation branch visibility ──────────────────────────────────────────
//
// A conversation is a chain of linear segments, not a per-message tree. When
// someone rewinds the chat ("redo"), we fork: a `conversation_branches` row
// records where the fork happened, new messages land on the new branch, and the
// old tail stays on the parent branch — reachable, not deleted.
//
// Which messages are visible is therefore derived, never stored. Walk the
// `parentBranchId` chain from the active branch to the root and emit half-open
// [minId, maxId) id ranges:
//
//   [ { branch: B,      min: forkedFrom(B),      max: ∞                 },
//     { branch: parent, min: forkedFrom(parent), max: forkedFrom(B)     },
//     ...
//     { branch: null,   min: 0,                  max: forkedFrom(oldest)} ]
//
// Every read path in the conversation stack must apply this predicate, or it
// will see messages from branches the reader has navigated away from. Missing
// it is a silent failure: the query still returns rows, just the wrong ones.

/** Root branch is represented as `null`, matching the nullable `branch_id` columns. */
export type BranchId = string | null

export interface BranchSegment {
	branch: BranchId
	/** Inclusive lower bound on `messages.id`. */
	minId: number
	/** Exclusive upper bound on `messages.id`; `null` = unbounded (the active branch). */
	maxId: number | null
}

// A cycle in `parentBranchId` should be impossible (a branch's parent always
// pre-exists it), but this walk runs on the synchronous path of every message
// list, so it must not be able to hang the request.
//
// Detected with a visited set rather than a depth cap. A depth cap would be
// wrong here: each rewind chains one branch onto the previous active branch, so
// chain depth EQUALS the number of rewinds in the conversation. Any fixed cap
// is therefore a silent rewind limit, not a corruption guard — the Nth rewind
// would trip it through entirely healthy data.

export interface BranchRow {
	id: string
	parentBranchId: string | null
	forkedFromMessageId: number
}

/** The whole conversation, unbranched — what every caller sees by default. */
const WHOLE_CONVERSATION: BranchSegment[] = [{ branch: null, minId: 0, maxId: null }]

/**
 * Fetch every branch row for the given conversations in one query.
 *
 * Batched deliberately: the conversation list resolves visibility for a whole
 * page at once, and a per-conversation round trip there would be N+1.
 */
export async function loadBranchRows(
	db: Database,
	conversationIds: string[],
): Promise<Map<string, BranchRow[]>> {
	const byConversation = new Map<string, BranchRow[]>()
	if (conversationIds.length === 0) return byConversation

	const rows = await db
		.select({
			conversationId: conversationBranches.conversationId,
			id: conversationBranches.id,
			parentBranchId: conversationBranches.parentBranchId,
			forkedFromMessageId: conversationBranches.forkedFromMessageId,
		})
		.from(conversationBranches)
		.where(inArray(conversationBranches.conversationId, conversationIds))

	for (const row of rows) {
		const list = byConversation.get(row.conversationId) ?? []
		list.push(row)
		byConversation.set(row.conversationId, list)
	}
	return byConversation
}

/** Pure segment walk over already-fetched branch rows. */
export function resolveSegmentsFrom(rows: BranchRow[], activeBranchId: BranchId): BranchSegment[] {
	if (!activeBranchId) return WHOLE_CONVERSATION

	const byId = new Map(rows.map((r) => [r.id, r]))

	const segments: BranchSegment[] = []
	// Upper bound of the segment being built: each branch hides everything at or
	// after the point its child forked away from it.
	let upperBound: number | null = null
	let cursor: BranchId = activeBranchId
	const visited = new Set<string>()

	while (cursor !== null) {
		// A cycle. Stop here rather than looping forever, and keep only what we
		// resolved — see `truncateOnCorruption` on why we must NOT fall back to
		// the whole conversation.
		if (visited.has(cursor)) {
			logger.warn('Branch chain contains a cycle — truncating visibility', {
				activeBranchId,
				branchId: cursor,
			})
			return truncateOnCorruption(segments)
		}
		visited.add(cursor)

		const branch = byId.get(cursor)
		// Unknown id: deleted, or belongs to another conversation.
		if (!branch) {
			logger.warn('Branch chain references an unknown branch — truncating visibility', {
				activeBranchId,
				branchId: cursor,
			})
			return truncateOnCorruption(segments)
		}

		segments.push({ branch: branch.id, minId: branch.forkedFromMessageId, maxId: upperBound })
		upperBound = branch.forkedFromMessageId
		cursor = branch.parentBranchId
	}

	segments.push({ branch: null, minId: 0, maxId: upperBound })
	return segments
}

/**
 * What to show when the branch chain can't be walked to the root.
 *
 * Emphatically NOT `WHOLE_CONVERSATION`: that predicate is `branch_id IS NULL`,
 * which is the *root* tail — for a branched conversation that is precisely the
 * content the reader rewound away from. Falling back to it would resurrect
 * discarded messages as the live thread and feed them to the agents, which is
 * the opposite of failing closed.
 *
 * Keeping the segments resolved so far shows strictly less: history older than
 * the corrupt link goes missing, but nothing appears that isn't genuinely on
 * this branch. An empty result shows nothing at all, which is the correct floor.
 */
function truncateOnCorruption(segments: BranchSegment[]): BranchSegment[] {
	return segments
}

/**
 * Resolve the ordered, newest-first list of id ranges visible on `activeBranchId`.
 *
 * Returns the whole-conversation segment when the conversation has never been
 * branched, so callers can use this unconditionally.
 */
export async function resolveBranchSegments(
	db: Database,
	conversationId: string,
	activeBranchId: BranchId,
): Promise<BranchSegment[]> {
	if (!activeBranchId) return WHOLE_CONVERSATION
	const rows = (await loadBranchRows(db, [conversationId])).get(conversationId) ?? []
	return resolveSegmentsFrom(rows, activeBranchId)
}

/**
 * Build the `WHERE` fragment restricting `messages` to the given segments.
 *
 * Pass the result alongside the caller's own conditions — it does NOT constrain
 * `conversationId`, since every caller already does.
 */
export function branchVisibilityCondition(segments: BranchSegment[]): SQL | undefined {
	const clauses = segments.map((seg) => {
		const parts: SQL[] = [
			seg.branch === null
				? (isNull(messages.branchId) as SQL)
				: (eq(messages.branchId, seg.branch) as SQL),
			sql`${messages.id} >= ${seg.minId}`,
		]
		if (seg.maxId !== null) parts.push(sql`${messages.id} < ${seg.maxId}`)
		return and(...parts) as SQL
	})
	// No segments means "nothing is visible", not "no filter". Returning
	// undefined here would drop the predicate from the caller's and(...) and
	// show every branch at once.
	if (clauses.length === 0) return sql`false`
	if (clauses.length === 1) return clauses[0]
	return or(...clauses) as SQL
}

/**
 * Convenience for the common case: look up the conversation's active branch and
 * return the visibility predicate for it.
 */
export async function activeBranchCondition(
	db: Database,
	conversationId: string,
): Promise<SQL | undefined> {
	const [row] = await db
		.select({ activeBranchId: conversations.activeBranchId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1)
	const segments = await resolveBranchSegments(db, conversationId, row?.activeBranchId ?? null)
	return branchVisibilityCondition(segments)
}

/**
 * Visibility predicate spanning several conversations at once, for the
 * conversation-list aggregates (unread counts, last-message snippets).
 *
 * Returns `undefined` when none of the conversations have ever been branched,
 * which is the overwhelmingly common case — so an unbranched workspace pays
 * nothing for this and the emitted SQL is byte-identical to before branching
 * existed. Only branched conversations get a predicate; the rest are admitted
 * wholesale by the leading NOT IN clause.
 */
export function multiConversationVisibilityCondition(
	branchRowsByConversation: Map<string, BranchRow[]>,
	activeBranchByConversation: Map<string, BranchId>,
): SQL | undefined {
	// Keyed on "has ever been branched", NOT on "is currently on a fork". A
	// conversation sitting back on its root branch still needs the predicate —
	// without it the leading NOT IN admits the whole conversation and the forked
	// tail lands in unread counts and list snippets, disagreeing with the thread
	// the reader actually sees when they open it.
	const branched = [...branchRowsByConversation.entries()].filter(([, rows]) => rows.length > 0)
	if (branched.length === 0) return undefined

	const clauses: SQL[] = [
		not(
			inArray(
				messages.conversationId,
				branched.map(([conversationId]) => conversationId),
			),
		) as SQL,
	]
	for (const [conversationId, rows] of branched) {
		const segments = resolveSegmentsFrom(
			rows,
			activeBranchByConversation.get(conversationId) ?? null,
		)
		const visible = branchVisibilityCondition(segments)
		clauses.push(and(eq(messages.conversationId, conversationId), visible) as SQL)
	}
	return or(...clauses) as SQL
}

/** A place where the thread forks, and the alternatives the reader can switch to. */
export interface BranchPoint {
	/**
	 * The message to render the switcher under, **on the branch being read** —
	 * not the raw `forkedFromMessageId`.
	 *
	 * Those differ, and conflating them hides the control exactly when it is
	 * needed. `forkedFromMessageId` lives on the parent branch and the segment
	 * walk bounds the parent EXCLUSIVELY at it, so on a freshly created branch
	 * that message is not visible — the client, which mounts the switcher by
	 * matching a rendered message id, would never mount it, stranding the reader
	 * on the new branch with no way back. So each option anchors on its own first
	 * message: `forkedFromMessageId` when the original continuation is active,
	 * and the re-posted copy at the head of a fork otherwise.
	 */
	messageId: number
	/** Index into `options` of the branch currently being read. */
	activeIndex: number
	/** Oldest first; index 0 is always the original continuation. */
	options: Array<{ branchId: BranchId }>
}

/**
 * The fork points to render a "‹ 2/3 ›" switcher at.
 *
 * A fork at message M means M's tail was rewound: the alternatives are the
 * original continuation (the parent branch) plus every branch forked at M, in
 * creation order. Only forks the reader can actually reach from the branch they
 * are on are returned — a fork that lives on a sibling branch is not reachable
 * without switching to that sibling first, and offering it would let one click
 * jump across two unrelated rewinds.
 */
export function buildBranchPoints(
	rows: BranchRow[],
	activeBranchId: BranchId,
	/** Lowest `messages.id` on each branch — see `loadFirstMessageIdByBranch`. */
	firstMessageIdByBranch: Map<string, number>,
): BranchPoint[] {
	if (rows.length === 0) return []

	// The chain of branches from root up to the active branch. Anything forked
	// off one of these is reachable; anything else is not.
	const byId = new Map(rows.map((r) => [r.id, r]))
	// Same visited-set termination as resolveSegmentsFrom, and for the same
	// reason: a depth cap here would silently truncate the ancestry set on a
	// long-but-healthy rewind chain, dropping valid options and reporting the
	// reader as being on the original when they are not.
	const ancestry = new Set<string>()
	let cursor: BranchId = activeBranchId
	while (cursor !== null && !ancestry.has(cursor)) {
		ancestry.add(cursor)
		cursor = byId.get(cursor)?.parentBranchId ?? null
	}

	// Group by fork point. Branches forked at the same message from the same
	// parent are siblings — the alternatives at that point.
	const groups = new Map<number, BranchRow[]>()
	for (const row of rows) {
		const siblings = groups.get(row.forkedFromMessageId) ?? []
		siblings.push(row)
		groups.set(row.forkedFromMessageId, siblings)
	}

	const points: BranchPoint[] = []
	for (const [messageId, siblings] of groups) {
		const reachable = siblings.filter(
			(b) => ancestry.has(b.id) || b.parentBranchId === null || ancestry.has(b.parentBranchId),
		)
		if (reachable.length === 0) continue

		// All siblings at one fork point share a parent — that parent is the
		// original continuation, option 0.
		const parentBranchId = reachable[0]?.parentBranchId ?? null
		const ordered = reachable.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		const options: Array<{ branchId: BranchId }> = [
			{ branchId: parentBranchId },
			...ordered.map((b) => ({ branchId: b.id })),
		]
		// Check the forked options before falling back to the parent: being on a
		// sibling puts BOTH that sibling and its parent in the ancestry set, so a
		// naive scan from index 0 would always report the original as active.
		const forkedIndex = ordered.findIndex((b) => ancestry.has(b.id))
		const activeIndex = forkedIndex === -1 ? 0 : forkedIndex + 1

		// Anchor on the active option's own first message, so the control renders
		// on the branch actually being read. Index 0 is the original continuation,
		// whose first message IS the fork point.
		const activeBranchOption = options[activeIndex]?.branchId ?? null
		const anchorId =
			activeBranchOption === null ? messageId : firstMessageIdByBranch.get(activeBranchOption)
		// A fork with no messages yet has nothing to anchor to. Dropping the point
		// is right: there is no bubble to hang it under, and inventing one would
		// put the switcher under an unrelated message.
		if (anchorId === undefined) continue

		points.push({ messageId: anchorId, activeIndex, options })
	}

	return points.sort((a, b) => a.messageId - b.messageId)
}

/**
 * Lowest `messages.id` on each non-root branch of a conversation.
 *
 * That first message is the re-posted copy the rewind wrote onto the new
 * branch, which is where the switcher for that fork belongs. Served by the
 * `(conversation_id, branch_id, id)` index added in migration 0065.
 */
export async function loadFirstMessageIdByBranch(
	db: Database,
	conversationId: string,
): Promise<Map<string, number>> {
	const rows = await db
		.select({ branchId: messages.branchId, firstId: min(messages.id) })
		.from(messages)
		.where(and(eq(messages.conversationId, conversationId), isNotNull(messages.branchId)))
		.groupBy(messages.branchId)

	const byBranch = new Map<string, number>()
	for (const row of rows) {
		if (row.branchId !== null && row.firstId !== null)
			byBranch.set(row.branchId, Number(row.firstId))
	}
	return byBranch
}
