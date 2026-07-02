import type { SafeMetadata } from '@maskin/shared'

export type BetStatusState = 'progressing' | 'waiting_on_human' | 'stalled' | 'idle'

export interface PendingActionTask {
	id: string
	title: string | null
	driver: string | null
	status: string
}

export interface PendingAction {
	kind: BetStatusState
	tasks: PendingActionTask[]
}

export interface DecisionEntry {
	taskId: string
	title: string | null
	decidedAt: string | null
}

export interface BetStatusResult {
	state: BetStatusState
	pendingAction: PendingAction | null
	decisionsSoFar: DecisionEntry[]
}

export interface BetLike {
	id: string
	type: string
	status: string
}

export interface ChildTaskLike {
	id: string
	type: string
	title: string | null
	status: string
	driver: string | null
	metadata: SafeMetadata | null
	updatedAt: string | null
}

const OPEN_STATUSES = new Set(['todo', 'in_progress', 'in_review'])
const WIP_STATUSES = new Set(['in_progress', 'in_review'])
const DONE_STATUSES = new Set(['done', 'completed'])

export const STALLED_THRESHOLD_MS = 72 * 60 * 60 * 1000

function isHumanDecision(task: ChildTaskLike): boolean {
	return task.metadata?.human_decision === true
}

function toPendingTask(task: ChildTaskLike): PendingActionTask {
	return {
		id: task.id,
		title: task.title,
		driver: task.driver,
		status: task.status,
	}
}

function latestUpdatedAt(tasks: ChildTaskLike[]): number | null {
	let latest: number | null = null
	for (const task of tasks) {
		if (!task.updatedAt) continue
		const ts = Date.parse(task.updatedAt)
		if (Number.isNaN(ts)) continue
		if (latest === null || ts > latest) latest = ts
	}
	return latest
}

export function classifyBetStatus(
	_bet: BetLike,
	childTasks: ChildTaskLike[],
	now: Date = new Date(),
): BetStatusResult {
	const openHumanDecisions: ChildTaskLike[] = []
	const wipTasks: ChildTaskLike[] = []
	const resolvedDecisions: ChildTaskLike[] = []

	for (const task of childTasks) {
		if (task.type !== 'task') continue
		const humanDecision = isHumanDecision(task)
		if (humanDecision && OPEN_STATUSES.has(task.status)) {
			openHumanDecisions.push(task)
		}
		if (humanDecision && DONE_STATUSES.has(task.status)) {
			resolvedDecisions.push(task)
		}
		if (WIP_STATUSES.has(task.status)) {
			wipTasks.push(task)
		}
	}

	const decisionsSoFar: DecisionEntry[] = resolvedDecisions
		.map((task) => ({
			taskId: task.id,
			title: task.title,
			decidedAt: task.updatedAt,
		}))
		.sort((a, b) => {
			const ta = a.decidedAt ? Date.parse(a.decidedAt) : 0
			const tb = b.decidedAt ? Date.parse(b.decidedAt) : 0
			return tb - ta
		})

	if (openHumanDecisions.length > 0) {
		return {
			state: 'waiting_on_human',
			pendingAction: { kind: 'waiting_on_human', tasks: openHumanDecisions.map(toPendingTask) },
			decisionsSoFar,
		}
	}

	if (wipTasks.length > 0) {
		return {
			state: 'progressing',
			pendingAction: { kind: 'progressing', tasks: wipTasks.map(toPendingTask) },
			decisionsSoFar,
		}
	}

	const latest = latestUpdatedAt(childTasks.filter((t) => t.type === 'task'))
	if (latest !== null && now.getTime() - latest > STALLED_THRESHOLD_MS) {
		return { state: 'stalled', pendingAction: null, decisionsSoFar }
	}

	return { state: 'idle', pendingAction: null, decisionsSoFar }
}
