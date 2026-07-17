import type { Database } from '@maskin/db'
import { objects, relationships, workspaces } from '@maskin/db/schema'
import { LOOP_ATTENTION_STATUSES, buildWebAppHref, stripTrailingSlash } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { WorkspaceSettings } from '../lib/types'

const MAX_ACTIVE_BETS = 10
const MAX_PAUSED_BETS = 5
const MAX_CLOSED_BETS = 5
const MAX_OPEN_INSIGHTS = 10
const MAX_LOOPS = 10
const MAX_LEDGER_LINES = 20

// Loops are ordered by how loud a signal they carry: `breached` (floor
// already broken) first, then `at-risk`, then `holding` (steady-state). This
// mirrors the bet convention where terminal transitions surface ahead of
// lifecycle noise — the DoD on T2 (Loops primitive) requires at-risk and
// breached appear ahead of holding using the composer's existing per-type
// grouping.
const LOOP_STATUS_PRIORITY: Record<string, number> = {
	breached: 0,
	'at-risk': 1,
	holding: 2,
}
const CLOSED_BETS_DAYS = 30
const LEDGER_MAX_LINES = 1000
const TITLE_MAX = 120
const EXCERPT_MAX = 180

/**
 * Briefing block prepended to every session's ACTION_PROMPT. Describes the
 * workspace terrain rather than prescribing steps — agentic models do better
 * with outcome-oriented context than with imperative checklists.
 *
 * Parameterised on the live `workspaceId` + `frontendUrl` so the agent sees
 * the exact host + workspace-scoped path it should emit when referencing an
 * object. Without this, agents hallucinate hosts like `app.maskin.ai`.
 */
export function buildWorkspaceStartupBlock(args: {
	workspaceId: string
	frontendUrl: string
}): string {
	const exampleUrl = buildWebAppHref(stripTrailingSlash(args.frontendUrl), args.workspaceId, {
		kind: 'object',
		id: '<id>',
	})
	return `## This workspace

This workspace works through bets — shaped, time-boxed outcomes.

- \`/agent/workspace/WORKSPACE.md\` holds the current snapshot (auto-generated from the object graph).
- Active bets are where in-flight work lives; closed bets carry verdicts that teach the next cycle.
- Dig deeper with \`get_objects\`, \`search_objects\`, \`list_relationships\`.
- Status updates and \`metadata.verdict\` are how bets stay legible to future sessions.
- A one-line note in \`/agent/workspace/SESSION_LEARNING.md\` rolls up into the next session's briefing.

When you reference an object in a comment, notification, or description, emit a markdown link with this exact format — do not guess the host or drop the workspace segment:

\`[title](${exampleUrl})\`

You decide how to achieve the goal. This is just the terrain.

---

`
}

export function workspaceLedgerKey(workspaceId: string): string {
	return `agents/${workspaceId}/_workspace/learnings.md`
}

/**
 * Read the last `maxLines` entries from the workspace-scoped learnings ledger.
 * Returns an empty array if the ledger does not exist or cannot be read.
 */
export async function readLedgerTail(
	storage: StorageProvider,
	workspaceId: string,
	maxLines: number,
): Promise<string[]> {
	const key = workspaceLedgerKey(workspaceId)
	try {
		if (!(await storage.exists(key))) return []
		const buf = await storage.get(key)
		const lines = buf
			.toString('utf-8')
			.split('\n')
			.filter((l) => l.length > 0)
		return lines.slice(-maxLines)
	} catch (err) {
		logger.warn('Failed to read workspace ledger', { workspaceId, error: String(err) })
		return []
	}
}

/**
 * Append a single-line entry to the workspace ledger. Caps the ledger at
 * LEDGER_MAX_LINES (oldest entries drop). No-op if `line` is empty after trim.
 *
 * Skips the append (rather than proceeding with an empty baseline) if the
 * current ledger cannot be read. Without this guard, a transient S3 error
 * followed by a successful `put` would silently wipe all prior entries.
 *
 * Note: read-modify-write is not atomic. If two sessions in the same workspace
 * complete within milliseconds of each other, one entry may be lost. V2 should
 * move to per-session files concatenated at read time to eliminate this race.
 */
export async function appendToLedger(
	storage: StorageProvider,
	workspaceId: string,
	line: string,
): Promise<void> {
	const trimmed = line.replace(/[\r\n]+/g, ' ').trim()
	if (!trimmed) return
	const key = workspaceLedgerKey(workspaceId)

	let exists: boolean
	try {
		exists = await storage.exists(key)
	} catch (err) {
		logger.warn('Failed to check ledger existence — skipping append', {
			workspaceId,
			error: String(err),
		})
		return
	}

	let existing = ''
	if (exists) {
		try {
			existing = (await storage.get(key)).toString('utf-8')
		} catch (err) {
			logger.warn('Failed to read ledger before append — skipping to avoid wipe', {
				workspaceId,
				error: String(err),
			})
			return
		}
	}

	const existingLines = existing.split('\n').filter((l) => l.length > 0)
	const nextLines = [...existingLines, trimmed].slice(-LEDGER_MAX_LINES)
	await storage.put(key, Buffer.from(`${nextLines.join('\n')}\n`, 'utf-8'))
}

function truncate(s: string | null | undefined, max: number): string {
	if (!s) return ''
	const collapsed = s.replace(/\s+/g, ' ').trim()
	if (collapsed.length <= max) return collapsed
	return `${collapsed.slice(0, max - 1)}…`
}

/**
 * Generate the agent-facing briefing for a workspace. Queries the object graph
 * for active/closed bets, open insights, child-task progress, and the recent
 * workspace learnings ledger, then renders a stable markdown document.
 *
 * This is the `feature_list.json` + `claude-progress.txt` equivalent from
 * Anthropic's Ralph Loop, adapted for knowledge work: always auto-generated,
 * never hand-edited, so it cannot rot.
 */
export async function renderWorkspaceBriefing(
	db: Database,
	storage: StorageProvider,
	workspaceId: string,
): Promise<string> {
	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) {
		return `# Workspace ${workspaceId}\n\nWorkspace not found.\n`
	}

	const settings = (ws.settings as WorkspaceSettings) ?? ({} as WorkspaceSettings)
	const displayNames = settings.display_names ?? {}
	const betLabel = displayNames.bet ?? 'Bet'
	const taskLabel = displayNames.task ?? 'Task'
	const insightLabel = displayNames.insight ?? 'Insight'
	const loopLabel = displayNames.loop ?? 'Loop'

	const since = new Date(Date.now() - CLOSED_BETS_DAYS * 24 * 60 * 60 * 1000)

	// Loops sort with attention-worthy statuses (breached, at-risk) ahead of
	// holding so the briefing surfaces "your standing commitments that need
	// you" at the top of the section. Uses `inArray` so `LOOP_ATTENTION_STATUSES`
	// stays the single source of truth shared with the unread-feed join in
	// routes/subscriptions.ts — no drift between the two surfaces.
	//
	// This coarse tier alone is not enough: `.limit(MAX_LOOPS)` is applied
	// against this ORDER BY at the DB level, so it must fully match
	// LOOP_STATUS_PRIORITY (breached > at-risk > holding), not just
	// "attention-worthy vs not". A 2-tier ORDER BY would let a fresher
	// `at-risk` loop win one of the MAX_LOOPS slots over an older `breached`
	// one, because the in-memory 3-tier sort below only re-sorts whatever
	// already survived the LIMIT. `loopBreachedPriority` breaks the tie within
	// the attention-worthy tier so breached rows are never truncated in favor
	// of at-risk ones.
	const loopHealthPriority = sql<number>`case when ${inArray(objects.status, [...LOOP_ATTENTION_STATUSES])} then 1 else 0 end`
	const loopBreachedPriority = sql<number>`case when ${eq(objects.status, 'breached')} then 1 else 0 end`

	// Independent queries run in parallel — they don't depend on each other.
	const [activeBets, pausedBets, closedBets, openInsights, loops] = await Promise.all([
		db
			.select()
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, 'bet'),
					inArray(objects.status, ['proposed', 'active']),
				),
			)
			.orderBy(desc(objects.updatedAt))
			.limit(MAX_ACTIVE_BETS),
		db
			.select()
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, 'bet'),
					eq(objects.status, 'paused'),
				),
			)
			.orderBy(desc(objects.updatedAt))
			.limit(MAX_PAUSED_BETS),
		db
			.select()
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, 'bet'),
					inArray(objects.status, ['succeeded', 'failed', 'completed']),
					gte(objects.updatedAt, since),
				),
			)
			.orderBy(desc(objects.updatedAt))
			.limit(MAX_CLOSED_BETS),
		db
			.select()
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, 'insight'),
					ne(objects.status, 'discarded'),
				),
			)
			.orderBy(desc(objects.createdAt))
			.limit(MAX_OPEN_INSIGHTS),
		// Loops — polymorphic filter on `type='loop'`, never `metadata_eq`, so
		// the week-4 kill signal on the parent bet can read this as usage of
		// the primitive rather than a bespoke query path.
		db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'loop')))
			.orderBy(desc(loopHealthPriority), desc(loopBreachedPriority), desc(objects.updatedAt))
			.limit(MAX_LOOPS),
	])

	// In-memory sort by health priority (breached → at-risk → holding), then
	// by recency within a status tier. Unknown statuses sort last so a future
	// schema addition doesn't silently jump the queue.
	const sortedLoops = [...loops].sort((a, b) => {
		const aRank = LOOP_STATUS_PRIORITY[a.status] ?? Number.POSITIVE_INFINITY
		const bRank = LOOP_STATUS_PRIORITY[b.status] ?? Number.POSITIVE_INFINITY
		if (aRank !== bRank) return aRank - bRank
		const aTime = a.updatedAt instanceof Date ? a.updatedAt.getTime() : 0
		const bTime = b.updatedAt instanceof Date ? b.updatedAt.getTime() : 0
		return bTime - aTime
	})

	// Child task progress for active bets: one batched relationship query, one
	// batched object query.
	const betIds = activeBets.map((b) => b.id)
	const childRels = betIds.length
		? await db
				.select()
				.from(relationships)
				.where(and(inArray(relationships.sourceId, betIds), eq(relationships.type, 'breaks_into')))
		: []

	const taskIds = childRels.map((r) => r.targetId)
	const childTasks = taskIds.length
		? await db
				.select()
				.from(objects)
				.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, taskIds)))
		: []

	const statusById = new Map(childTasks.map((t) => [t.id, t.status]))
	const progressByBet = new Map<string, { total: number; done: number }>()
	for (const rel of childRels) {
		const entry = progressByBet.get(rel.sourceId) ?? { total: 0, done: 0 }
		entry.total += 1
		if (statusById.get(rel.targetId) === 'done') entry.done += 1
		progressByBet.set(rel.sourceId, entry)
	}

	const ledgerLines = await readLedgerTail(storage, workspaceId, MAX_LEDGER_LINES)

	const out: string[] = []
	out.push(`# ${ws.name} — workspace briefing`)
	out.push('')
	out.push(
		"This file is auto-generated at session start from the workspace's current state. It is your map — read it first, then use MCP tools to go deeper.",
	)
	out.push('')

	out.push(`## Active ${betLabel.toLowerCase()}s`)
	out.push('')
	if (activeBets.length === 0) {
		const emptyHint =
			openInsights.length > 0
				? ` Consider proposing one from an open ${insightLabel.toLowerCase()}.`
				: ''
		out.push(`_No active ${betLabel.toLowerCase()}s.${emptyHint}_`)
	} else {
		for (const bet of activeBets) {
			const counts = progressByBet.get(bet.id)
			const taskNote = counts
				? ` · ${counts.done}/${counts.total} ${taskLabel.toLowerCase()}s done`
				: ''
			const meta = (bet.metadata as Record<string, unknown> | null) ?? {}
			const appetite =
				typeof meta.appetite === 'string' && meta.appetite.length > 0
					? ` · appetite: ${truncate(meta.appetite, 40)}`
					: ''
			out.push(`- **${truncate(bet.title, TITLE_MAX)}** [${bet.status}]${appetite}${taskNote}`)
			const excerpt = truncate(bet.content, EXCERPT_MAX)
			if (excerpt) out.push(`  ${excerpt}`)
			out.push(`  id: \`${bet.id}\``)
		}
	}
	out.push('')

	if (pausedBets.length > 0) {
		out.push(`## Paused ${betLabel.toLowerCase()}s`)
		out.push('')
		out.push(
			'_Explicitly set aside — not part of the current cycle. Revisit only if a new signal changes the calculus._',
		)
		for (const bet of pausedBets) {
			out.push(`- **${truncate(bet.title, TITLE_MAX)}**`)
		}
		out.push('')
	}

	out.push(`## Recently closed ${betLabel.toLowerCase()}s (last ${CLOSED_BETS_DAYS} days)`)
	out.push('')
	if (closedBets.length === 0) {
		out.push(`_None in the last ${CLOSED_BETS_DAYS} days._`)
	} else {
		for (const bet of closedBets) {
			const meta = (bet.metadata as Record<string, unknown> | null) ?? {}
			const verdict =
				typeof meta.verdict === 'string' && meta.verdict.length > 0
					? ` — ${truncate(meta.verdict, EXCERPT_MAX)}`
					: ''
			out.push(`- **${truncate(bet.title, TITLE_MAX)}** [${bet.status}]${verdict}`)
		}
	}
	out.push('')

	// Silent when empty — matches the paused-bets pattern. An empty Loop set
	// (the day-1 state before any bet has graduated) should not shout at the
	// reader with a placeholder line.
	if (sortedLoops.length > 0) {
		out.push(`## ${loopLabel}s`)
		out.push('')
		for (const loop of sortedLoops) {
			const meta = (loop.metadata as Record<string, unknown> | null) ?? {}
			const floor =
				typeof meta.floor === 'string' && meta.floor.length > 0
					? ` · floor: ${truncate(meta.floor, 60)}`
					: ''
			const cadence =
				typeof meta.cadence === 'string' && meta.cadence.length > 0
					? ` · cadence: ${truncate(meta.cadence, 40)}`
					: ''
			out.push(`- **${truncate(loop.title, TITLE_MAX)}** [${loop.status}]${floor}${cadence}`)
		}
		out.push('')
	}

	out.push(`## Open ${insightLabel.toLowerCase()}s`)
	out.push('')
	if (openInsights.length === 0) {
		out.push(`_No open ${insightLabel.toLowerCase()}s._`)
	} else {
		for (const insight of openInsights) {
			out.push(`- ${truncate(insight.title, TITLE_MAX)}`)
		}
		out.push('')
		out.push(
			`_Use \`get_objects\` with \`type: '${insightLabel.toLowerCase()}'\` for the full list._`,
		)
	}
	out.push('')

	out.push('## Recent workspace learnings')
	out.push('')
	if (ledgerLines.length === 0) {
		out.push('_No prior session learnings yet._')
	} else {
		for (const line of ledgerLines) {
			out.push(`- ${line}`)
		}
	}
	out.push('')

	out.push('## Digging deeper')
	out.push('')
	out.push('This briefing is a summary. Use the Maskin MCP tools to explore further:')
	out.push('- `get_objects` — list objects by type/status/owner')
	out.push('- `search_objects` — full-text search over titles and content')
	out.push('- `get_object` — fetch an object by id with its relationships')
	out.push('- `list_relationships` — graph edges between objects')
	out.push(
		`- \`update_objects\` — update status, content, metadata (set \`metadata.verdict\` when closing a ${betLabel.toLowerCase()})`,
	)
	out.push('')

	return out.join('\n')
}
