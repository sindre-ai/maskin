#!/usr/bin/env -S node --import tsx
/**
 * End-to-end autonomy test for the Parallelization bet (f98547ae).
 *
 * Creates a synthetic bet via the /api/graph endpoint (same code path as the
 * MCP `create_objects` tool) with four tasks whose descriptions encode a
 * diamond dependency graph in prose:
 *
 *     T1
 *    /  \
 *   T2  T3
 *    \  /
 *     T4
 *
 * The harness then walks away and polls workspace state. PASS means every
 * task reaches `done` AND the bet reaches `completed` within the wall-clock
 * budget. FAIL dumps task states, recent events, and notifications so root-
 * causing is a five-minute job.
 */

import { createApiClient } from './api'
import { parseFinitePositiveEnv } from './parse-env'

type Status = string

interface ObjectRow {
	id: string
	type: string
	title: string | null
	content: string | null
	status: Status
	metadata: Record<string, unknown> | null
	activeSessionId: string | null
	updatedAt: string
	createdAt: string
}

interface RelationshipRow {
	id: string
	sourceId: string
	targetId: string
	type: string
}

interface GraphResponse {
	object: ObjectRow
	relationships: RelationshipRow[]
	connected_objects: ObjectRow[]
}

interface EventRow {
	id: number
	action: string
	entityType: string
	entityId: string
	createdAt: string
	metadata?: Record<string, unknown> | null
}

interface NotificationRow {
	id: string
	type: string
	title: string
	status: string
	objectId: string | null
	sourceActorId: string | null
	createdAt: string
}

interface SessionRow {
	id: string
	actorId: string
	objectId: string | null
	status: string
	startedAt: string | null
	endedAt: string | null
}

interface Snapshot {
	at: string
	bet: ObjectRow
	tasks: ObjectRow[]
	blocksEdges: RelationshipRow[]
	parallelism: number
}

const env = (key: string, fallback?: string) => {
	const v = process.env[key] ?? fallback
	if (v === undefined) throw new Error(`Missing required env: ${key}`)
	return v
}

const BASE_URL = env('MASKIN_API_BASE_URL', 'http://localhost:5173')
const API_KEY = env('MASKIN_API_KEY')
const WORKSPACE_ID = env('MASKIN_WORKSPACE_ID')
const BUDGET_MS = parseFinitePositiveEnv(process.env.E2E_BUDGET_MIN, 90, 'E2E_BUDGET_MIN') * 60_000
const POLL_MS = parseFinitePositiveEnv(process.env.E2E_POLL_SEC, 30, 'E2E_POLL_SEC') * 1_000
const REQUEST_TIMEOUT_MS =
	parseFinitePositiveEnv(process.env.E2E_REQUEST_TIMEOUT_SEC, 30, 'E2E_REQUEST_TIMEOUT_SEC') * 1_000
const REPORT_PATH = process.env.E2E_REPORT_PATH ?? null
const KEEP_OBJECTS = process.env.E2E_KEEP_OBJECTS === '1'

const headers = () => ({
	'Content-Type': 'application/json',
	Authorization: `Bearer ${API_KEY}`,
	'X-Workspace-Id': WORKSPACE_ID,
})

const api = createApiClient({
	baseUrl: BASE_URL,
	headers,
	timeoutMs: REQUEST_TIMEOUT_MS,
})

const RUN_ID = `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
const SYNTHETIC_TAG = 'parallel-bet-autonomy-test'

function buildSyntheticGraph() {
	// Four tiny, low-stakes tasks. Prose dependencies only — no blocks edges
	// created here, since materialization from prose is one of the things
	// being verified.
	const taskBriefs = [
		{
			$id: 't1',
			title: `[${SYNTHETIC_TAG}] T1 — add a logging line`,
			content: [
				'## Why',
				'Synthetic root task in the autonomy E2E. Standalone (no dependencies).',
				'',
				'## What',
				`Add a single \`console.log("[${RUN_ID}] T1")\` line to a sentinel comment block in \`scripts/e2e/SYNTHETIC.md\`. This task is intentionally no-code: edit only the doc.`,
				'',
				'## Definition of done',
				`- The doc contains a line tagged with the run ID \`${RUN_ID}\` from T1.`,
				'',
				'## Constraints',
				'- Touch only `scripts/e2e/SYNTHETIC.md`.',
				'',
				'## Out of scope',
				'- Any code change.',
				'',
				'## References',
				`- E2E run: \`${RUN_ID}\``,
			].join('\n'),
		},
		{
			$id: 't2',
			title: `[${SYNTHETIC_TAG}] T2 — add config field (depends on T1)`,
			content: [
				'## Why',
				'Synthetic mid-task in the autonomy E2E. **Depends on T1** — must run after T1 completes.',
				'',
				'## What',
				`After T1 has appended its sentinel, append a second line tagged with \`${RUN_ID}\` from T2 in \`scripts/e2e/SYNTHETIC.md\`.`,
				'',
				'## Definition of done',
				`- The doc contains a line tagged with the run ID \`${RUN_ID}\` from T2, ordered after T1's line.`,
				'',
				'## Constraints',
				'- Touch only `scripts/e2e/SYNTHETIC.md`.',
				'',
				'## Out of scope',
				'- Any code change.',
				'',
				'## References',
				`- E2E run: \`${RUN_ID}\``,
				'- Depends on Task T1 (above).',
			].join('\n'),
		},
		{
			$id: 't3',
			title: `[${SYNTHETIC_TAG}] T3 — add comment (depends on T1)`,
			content: [
				'## Why',
				'Synthetic mid-task in the autonomy E2E. **Depends on T1** — runs in parallel with T2.',
				'',
				'## What',
				`After T1 has appended its sentinel, append a third line tagged with \`${RUN_ID}\` from T3 in \`scripts/e2e/SYNTHETIC.md\`.`,
				'',
				'## Definition of done',
				`- The doc contains a line tagged with the run ID \`${RUN_ID}\` from T3.`,
				'',
				'## Constraints',
				'- Touch only `scripts/e2e/SYNTHETIC.md`.',
				'',
				'## Out of scope',
				'- Any code change.',
				'',
				'## References',
				`- E2E run: \`${RUN_ID}\``,
				'- Depends on Task T1 (above). Independent of T2.',
			].join('\n'),
		},
		{
			$id: 't4',
			title: `[${SYNTHETIC_TAG}] T4 — final marker (depends on T2 and T3)`,
			content: [
				'## Why',
				'Synthetic leaf task. **Depends on Tasks T2 and T3** — must run after both.',
				'',
				'## What',
				`After T2 and T3 have both appended their lines, append a closing line tagged with \`${RUN_ID}\` from T4 in \`scripts/e2e/SYNTHETIC.md\`.`,
				'',
				'## Definition of done',
				`- The doc contains a closing line tagged with the run ID \`${RUN_ID}\` from T4, ordered after both T2 and T3.`,
				'',
				'## Constraints',
				'- Touch only `scripts/e2e/SYNTHETIC.md`.',
				'',
				'## Out of scope',
				'- Any code change.',
				'',
				'## References',
				`- E2E run: \`${RUN_ID}\``,
				'- Depends on Tasks T2 and T3 (above).',
			].join('\n'),
		},
	]

	const bet = {
		$id: 'bet',
		type: 'bet',
		title: `[${SYNTHETIC_TAG}] Autonomy E2E — ${RUN_ID}`,
		status: 'proposed',
		content: [
			'## Synthetic E2E bet',
			'',
			`Run ID: \`${RUN_ID}\``,
			'',
			'This bet is generated by `scripts/e2e/parallel-bet-autonomy.ts` to verify',
			"that the Parallelization bet's pipeline runs end-to-end without human input.",
			'It is intentionally tiny and low-stakes — task content edits a single',
			'sentinel doc and nothing else. Safe to leave behind on failure; the harness',
			'tries to clean it up on success.',
			'',
			'## Diamond dependency graph (prose)',
			'',
			'- T1 — root, standalone',
			'- T2 — depends on T1',
			'- T3 — depends on T1',
			'- T4 — depends on T2 and T3',
			'',
			'## What this verifies',
			'',
			'- `Bet Proposed → Plan Tasks` fires on programmatic creation.',
			'- Bet Decomposer materializes `blocks` edges from the prose above.',
			'- `update_objects → status_changed` propagation reliably fires triggers.',
			'- Tasks T2 and T3 run in parallel after T1 lands.',
			'- Bet reaches `completed` once T4 lands.',
		].join('\n'),
		metadata: {
			synthetic_e2e: true,
			synthetic_run_id: RUN_ID,
		},
	}

	return {
		nodes: [
			bet,
			...taskBriefs.map((t) => ({
				$id: t.$id,
				type: 'task',
				title: t.title,
				content: t.content,
				status: 'todo',
				metadata: { synthetic_e2e: true, synthetic_run_id: RUN_ID },
			})),
		],
		edges: taskBriefs.map((t) => ({
			source: 'bet',
			target: t.$id,
			type: 'breaks_into',
		})),
	}
}

interface CreatedGraph {
	betId: string
	taskIds: { t1: string; t2: string; t3: string; t4: string }
}

async function createSyntheticBet(): Promise<CreatedGraph> {
	const graph = buildSyntheticGraph()
	const result = await api<{
		nodes: Array<ObjectRow & { $id: string }>
		edges: RelationshipRow[]
	}>('POST', '/api/graph', graph)

	const byTempId = new Map(result.nodes.map((n) => [n.$id, n.id]))
	const betId = byTempId.get('bet')
	const t1 = byTempId.get('t1')
	const t2 = byTempId.get('t2')
	const t3 = byTempId.get('t3')
	const t4 = byTempId.get('t4')
	if (!betId || !t1 || !t2 || !t3 || !t4) {
		throw new Error(`Graph response missing $id mapping: ${JSON.stringify(result.nodes)}`)
	}
	return { betId, taskIds: { t1, t2, t3, t4 } }
}

async function snapshotBet(betId: string): Promise<Snapshot> {
	const graph = await api<GraphResponse>('GET', `/api/objects/${betId}/graph`)
	const breakInto = graph.relationships.filter(
		(r) => r.type === 'breaks_into' && r.sourceId === betId,
	)
	const taskIds = new Set(breakInto.map((r) => r.targetId))
	const tasks = graph.connected_objects.filter((o) => taskIds.has(o.id))
	const blocksEdges = graph.relationships.filter((r) => r.type === 'blocks')
	const parallelism = tasks.filter(
		(t) => t.status === 'in_progress' || t.status === 'in_review',
	).length
	return {
		at: new Date().toISOString(),
		bet: graph.object,
		tasks,
		blocksEdges,
		parallelism,
	}
}

async function fetchEventsSince(sinceId: number, limit = 100): Promise<EventRow[]> {
	const params = new URLSearchParams({ since: String(sinceId), limit: String(limit) })
	return api<EventRow[]>('GET', `/api/events/history?${params}`)
}

async function fetchNotificationsForBet(betId: string): Promise<NotificationRow[]> {
	const params = new URLSearchParams({ object_id: betId, limit: '100' })
	return api<NotificationRow[]>('GET', `/api/notifications?${params}`)
}

async function fetchSessionsForObject(objectId: string): Promise<SessionRow[]> {
	// /api/sessions doesn't filter by object directly; we fetch recent and filter.
	const sessions = await api<SessionRow[]>('GET', '/api/sessions?limit=100')
	return sessions.filter((s) => s.objectId === objectId)
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms))
}

interface RunReport {
	runId: string
	verdict: 'PASS' | 'FAIL'
	failureReason?: string
	betId: string
	taskIds: Record<string, string>
	startedAt: string
	endedAt: string
	cycleTimeMs: number
	maxParallelism: number
	taskCycleTimes: Record<string, { firstSeenAt: string; doneAt: string | null; ms: number | null }>
	watchdogKickTotal: number
	finalSnapshot: Snapshot
	blocksEdgeCount: number
	notifications: NotificationRow[]
	recentEvents?: EventRow[]
	taskSessions?: Record<string, SessionRow[]>
}

async function run() {
	console.log(`[${RUN_ID}] starting parallel-bet-autonomy E2E`)
	console.log(
		`[${RUN_ID}] base=${BASE_URL} workspace=${WORKSPACE_ID} budget=${BUDGET_MS / 60_000}min poll=${POLL_MS / 1000}s req_timeout=${REQUEST_TIMEOUT_MS / 1000}s`,
	)

	const startedAt = Date.now()
	const startedAtIso = new Date(startedAt).toISOString()
	const startEvents = await api<EventRow[]>('GET', '/api/events/history?limit=1')
	const sinceEventId = startEvents[0]?.id ?? 0

	const created = await createSyntheticBet()
	console.log(`[${RUN_ID}] created bet ${created.betId}`)
	console.log(`[${RUN_ID}] tasks: ${JSON.stringify(created.taskIds)}`)

	const taskFirstSeen = new Map<string, string>()
	const taskDoneAt = new Map<string, string>()
	let maxParallelism = 0
	let lastSnapshot: Snapshot | null = null

	const deadline = startedAt + BUDGET_MS

	while (Date.now() < deadline) {
		const snap = await snapshotBet(created.betId)
		lastSnapshot = snap
		maxParallelism = Math.max(maxParallelism, snap.parallelism)

		for (const t of snap.tasks) {
			if (!taskFirstSeen.has(t.id)) taskFirstSeen.set(t.id, snap.at)
			if (t.status === 'done' && !taskDoneAt.has(t.id)) taskDoneAt.set(t.id, snap.at)
		}

		const allDone = snap.tasks.length > 0 && snap.tasks.every((t) => t.status === 'done')
		const betCompleted = snap.bet.status === 'completed' || snap.bet.status === 'succeeded'

		console.log(
			`[${RUN_ID}] +${Math.round((Date.now() - startedAt) / 1000)}s bet=${snap.bet.status} tasks=${snap.tasks
				.map((t) => `${t.title?.match(/T\d/)?.[0] ?? t.id.slice(0, 4)}:${t.status}`)
				.join(' ')} parallel=${snap.parallelism} blocks=${snap.blocksEdges.length}`,
		)

		if (allDone && betCompleted) {
			const endedAt = Date.now()
			const taskCycleTimes: RunReport['taskCycleTimes'] = {}
			for (const t of snap.tasks) {
				const first = taskFirstSeen.get(t.id) ?? snap.at
				const done = taskDoneAt.get(t.id) ?? null
				taskCycleTimes[t.id] = {
					firstSeenAt: first,
					doneAt: done,
					ms: done ? new Date(done).getTime() - new Date(first).getTime() : null,
				}
			}
			const notifications = await fetchNotificationsForBet(created.betId)
			const watchdogKickTotal = snap.tasks.reduce(
				(acc, t) => acc + Number(t.metadata?.watchdog_kicks ?? 0),
				0,
			)
			const report: RunReport = {
				runId: RUN_ID,
				verdict: 'PASS',
				betId: created.betId,
				taskIds: created.taskIds,
				startedAt: startedAtIso,
				endedAt: new Date(endedAt).toISOString(),
				cycleTimeMs: endedAt - startedAt,
				maxParallelism,
				taskCycleTimes,
				watchdogKickTotal,
				finalSnapshot: snap,
				blocksEdgeCount: snap.blocksEdges.length,
				notifications,
			}
			await emitReport(report)
			if (!KEEP_OBJECTS) await cleanup(created)
			process.exit(0)
		}

		await sleep(POLL_MS)
	}

	// FAIL — wall-clock elapsed
	const snap = lastSnapshot ?? (await snapshotBet(created.betId))
	const recentEvents = await fetchEventsSince(sinceEventId, 100).catch(() => [])
	const notifications = await fetchNotificationsForBet(created.betId).catch(() => [])
	const taskSessions: Record<string, SessionRow[]> = {}
	for (const t of snap.tasks) {
		taskSessions[t.id] = await fetchSessionsForObject(t.id).catch(() => [])
	}
	const watchdogKickTotal = snap.tasks.reduce(
		(acc, t) => acc + Number(t.metadata?.watchdog_kicks ?? 0),
		0,
	)
	const taskCycleTimes: RunReport['taskCycleTimes'] = {}
	for (const t of snap.tasks) {
		const first = taskFirstSeen.get(t.id) ?? snap.at
		const done = taskDoneAt.get(t.id) ?? null
		taskCycleTimes[t.id] = {
			firstSeenAt: first,
			doneAt: done,
			ms: done ? new Date(done).getTime() - new Date(first).getTime() : null,
		}
	}
	const report: RunReport = {
		runId: RUN_ID,
		verdict: 'FAIL',
		failureReason: `wall-clock budget of ${BUDGET_MS / 60_000} minutes elapsed; bet=${snap.bet.status} tasks=${snap.tasks
			.map((t) => `${t.title?.match(/T\d/)?.[0] ?? t.id.slice(0, 4)}:${t.status}`)
			.join(' ')}`,
		betId: created.betId,
		taskIds: created.taskIds,
		startedAt: startedAtIso,
		endedAt: new Date().toISOString(),
		cycleTimeMs: Date.now() - startedAt,
		maxParallelism,
		taskCycleTimes,
		watchdogKickTotal,
		finalSnapshot: snap,
		blocksEdgeCount: snap.blocksEdges.length,
		notifications,
		recentEvents,
		taskSessions,
	}
	await emitReport(report)
	console.error(`[${RUN_ID}] FAIL — ${report.failureReason}`)
	if (!KEEP_OBJECTS) await cleanup(created)
	process.exit(1)
}

async function cleanup(created: CreatedGraph) {
	const ids = [
		created.taskIds.t4,
		created.taskIds.t3,
		created.taskIds.t2,
		created.taskIds.t1,
		created.betId,
	]
	for (const id of ids) {
		try {
			await api('DELETE', `/api/objects/${id}`)
		} catch (err) {
			console.warn(`[${RUN_ID}] cleanup: failed to delete ${id}: ${(err as Error).message}`)
		}
	}
}

async function emitReport(report: RunReport) {
	const json = JSON.stringify(report, null, 2)
	console.log(`[${RUN_ID}] === REPORT ===`)
	console.log(json)
	if (REPORT_PATH) {
		const { writeFile } = await import('node:fs/promises')
		await writeFile(REPORT_PATH, json, 'utf-8')
		console.log(`[${RUN_ID}] report written to ${REPORT_PATH}`)
	}
}

run().catch((err) => {
	console.error(`[${RUN_ID}] FATAL`, err)
	process.exit(2)
})
