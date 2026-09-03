import type { Database } from '@maskin/db'
import { objects, relationships, workspaces } from '@maskin/db/schema'
import { buildWebAppHref, stripTrailingSlash } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { WorkspaceSettings } from '../lib/types'

const MAX_ACTIVE_BETS = 10
const MAX_PAUSED_BETS = 5
const MAX_CLOSED_BETS = 5
const MAX_OPEN_INSIGHTS = 10
const MAX_LEDGER_LINES = 20

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
 * One bet as the briefing sees it. Strings are pre-truncated to the widths the
 * documents render at, so the agent doc and the spoken script quote identical
 * text. `null` means the field was absent; `''` means it was present but blank
 * — the agent doc distinguishes the two.
 */
export interface BriefingBetFact {
	id: string
	title: string
	status: string
	appetite: string | null
	verdict: string | null
	excerpt: string
	/** Child-task rollup. Null when the bet has no `breaks_into` children, and
	 *  only ever populated for active bets — the other tiers don't render it. */
	progress: { done: number; total: number } | null
}

export interface BriefingInsightFact {
	id: string
	title: string
}

export interface BriefingLabels {
	bet: string
	task: string
	insight: string
}

/**
 * Everything both briefing documents are built from — one query pass, no
 * formatting. `formatAgentBriefing` renders the markdown agents receive at
 * session start; `services/spoken-brief.ts` hands the same facts to the
 * workspace's default agent to be written as prose for a human to listen to.
 *
 * Splitting the two matters because they have different readers. The agent doc
 * addresses an agent ("It is your map"), lists object ids, and closes with MCP
 * tool names — none of which belongs in something spoken aloud.
 */
export interface BriefingFacts {
	workspaceId: string
	/** False when the workspace row is missing — both renderers degrade to a
	 *  "not found" document rather than throwing. */
	found: boolean
	workspaceName: string
	labels: BriefingLabels
	activeBets: BriefingBetFact[]
	pausedBets: BriefingBetFact[]
	closedBets: BriefingBetFact[]
	openInsights: BriefingInsightFact[]
	ledgerLines: string[]
	closedBetsDays: number
}

/**
 * Reads an optional free-text metadata field. Mirrors the original inline
 * guard exactly — a present-but-whitespace value returns `''` (rendered as an
 * empty label), an absent or non-string value returns null (label omitted).
 */
function metaText(meta: Record<string, unknown>, key: string, max: number): string | null {
	const raw = meta[key]
	if (typeof raw !== 'string' || raw.length === 0) return null
	return truncate(raw, max)
}

function objectMeta(row: { metadata: unknown }): Record<string, unknown> {
	return (row.metadata as Record<string, unknown> | null) ?? {}
}

/**
 * Query the object graph once and return the briefing's raw material. Shared
 * by the agent-facing markdown and the human-facing spoken script so the two
 * can never drift on what the workspace currently looks like.
 */
export async function collectBriefingFacts(
	db: Database,
	storage: StorageProvider,
	workspaceId: string,
): Promise<BriefingFacts> {
	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) {
		return {
			workspaceId,
			found: false,
			workspaceName: '',
			labels: { bet: 'Bet', task: 'Task', insight: 'Insight' },
			activeBets: [],
			pausedBets: [],
			closedBets: [],
			openInsights: [],
			ledgerLines: [],
			closedBetsDays: CLOSED_BETS_DAYS,
		}
	}

	const settings = (ws.settings as WorkspaceSettings) ?? ({} as WorkspaceSettings)
	const displayNames = settings.display_names ?? {}
	const labels: BriefingLabels = {
		bet: displayNames.bet ?? 'Bet',
		task: displayNames.task ?? 'Task',
		insight: displayNames.insight ?? 'Insight',
		// Fall back to legacy `loop` display name for workspaces that haven't yet
		// re-seeded post-rename (0-row prod today, but dev/test fixtures still
		// carry the old key).
	}

	const since = new Date(Date.now() - CLOSED_BETS_DAYS * 24 * 60 * 60 * 1000)

	// Independent queries run in parallel — they don't depend on each other.
	const [activeBets, pausedBets, closedBets, openInsights] = await Promise.all([
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
	])

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

	type ObjectRow = (typeof activeBets)[number]
	const toBet = (row: ObjectRow, withProgress: boolean): BriefingBetFact => {
		const meta = objectMeta(row)
		return {
			id: row.id,
			title: truncate(row.title, TITLE_MAX),
			status: row.status,
			appetite: metaText(meta, 'appetite', 40),
			verdict: metaText(meta, 'verdict', EXCERPT_MAX),
			excerpt: truncate(row.content, EXCERPT_MAX),
			progress: withProgress ? (progressByBet.get(row.id) ?? null) : null,
		}
	}

	return {
		workspaceId,
		found: true,
		workspaceName: ws.name,
		labels,
		activeBets: activeBets.map((row) => toBet(row, true)),
		pausedBets: pausedBets.map((row) => toBet(row, false)),
		closedBets: closedBets.map((row) => toBet(row, false)),
		openInsights: openInsights.map((row) => ({
			id: row.id,
			title: truncate(row.title, TITLE_MAX),
		})),
		ledgerLines,
		closedBetsDays: CLOSED_BETS_DAYS,
	}
}

/**
 * Render the agent-facing briefing markdown — the document written to
 * `/agent/workspace/WORKSPACE.md` at session start and returned by
 * `GET /api/briefing`. Addressed to an agent, not a person: it carries object
 * ids and closes with the MCP tools to dig further.
 */
export function formatAgentBriefing(facts: BriefingFacts): string {
	if (!facts.found) {
		return `# Workspace ${facts.workspaceId}\n\nWorkspace not found.\n`
	}

	const betLabel = facts.labels.bet
	const taskLabel = facts.labels.task
	const insightLabel = facts.labels.insight

	const out: string[] = []
	out.push(`# ${facts.workspaceName} — workspace briefing`)
	out.push('')
	out.push(
		"This file is auto-generated at session start from the workspace's current state. It is your map — read it first, then use MCP tools to go deeper.",
	)
	out.push('')

	out.push(`## Active ${betLabel.toLowerCase()}s`)
	out.push('')
	if (facts.activeBets.length === 0) {
		const emptyHint =
			facts.openInsights.length > 0
				? ` Consider proposing one from an open ${insightLabel.toLowerCase()}.`
				: ''
		out.push(`_No active ${betLabel.toLowerCase()}s.${emptyHint}_`)
	} else {
		for (const bet of facts.activeBets) {
			const taskNote = bet.progress
				? ` · ${bet.progress.done}/${bet.progress.total} ${taskLabel.toLowerCase()}s done`
				: ''
			const appetite = bet.appetite === null ? '' : ` · appetite: ${bet.appetite}`
			out.push(`- **${bet.title}** [${bet.status}]${appetite}${taskNote}`)
			if (bet.excerpt) out.push(`  ${bet.excerpt}`)
			out.push(`  id: \`${bet.id}\``)
		}
	}
	out.push('')

	if (facts.pausedBets.length > 0) {
		out.push(`## Paused ${betLabel.toLowerCase()}s`)
		out.push('')
		out.push(
			'_Explicitly set aside — not part of the current cycle. Revisit only if a new signal changes the calculus._',
		)
		for (const bet of facts.pausedBets) {
			out.push(`- **${bet.title}**`)
		}
		out.push('')
	}

	out.push(`## Recently closed ${betLabel.toLowerCase()}s (last ${facts.closedBetsDays} days)`)
	out.push('')
	if (facts.closedBets.length === 0) {
		out.push(`_None in the last ${facts.closedBetsDays} days._`)
	} else {
		for (const bet of facts.closedBets) {
			const verdict = bet.verdict === null ? '' : ` — ${bet.verdict}`
			out.push(`- **${bet.title}** [${bet.status}]${verdict}`)
		}
	}
	out.push('')

	out.push(`## Open ${insightLabel.toLowerCase()}s`)
	out.push('')
	if (facts.openInsights.length === 0) {
		out.push(`_No open ${insightLabel.toLowerCase()}s._`)
	} else {
		for (const insight of facts.openInsights) {
			out.push(`- ${insight.title}`)
		}
		out.push('')
		out.push(
			`_Use \`get_objects\` with \`type: '${insightLabel.toLowerCase()}'\` for the full list._`,
		)
	}
	out.push('')

	out.push('## Recent workspace learnings')
	out.push('')
	if (facts.ledgerLines.length === 0) {
		out.push('_No prior session learnings yet._')
	} else {
		for (const line of facts.ledgerLines) {
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
	return formatAgentBriefing(await collectBriefingFacts(db, storage, workspaceId))
}
