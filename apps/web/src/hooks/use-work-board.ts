import { useBets } from '@/hooks/use-bets'
import { useObjects } from '@/hooks/use-objects'
import { useRelationships } from '@/hooks/use-relationships'
import type { ObjectResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useMemo } from 'react'

export const ACTIVE_BET_STATUSES = ['signal', 'proposed', 'active'] as const
export const INACTIVE_BET_STATUSES = ['completed', 'succeeded', 'failed', 'paused'] as const
export const BLOCKED_STATUS = 'blocked'

export const DEFAULT_COLUMN_STATUSES: string[] = [
	'backlog',
	'todo',
	'in_progress',
	'in_review',
	'testing',
	'done',
]

export interface BoardSwimlane {
	/** Parent bet, or null for the "No bet" lane. */
	bet: ObjectResponse | null
	/** Tasks grouped by status. Keys are the column statuses. */
	columns: Record<string, ObjectResponse[]>
	/** Tasks in the blocked band (status === 'blocked'). */
	blocked: ObjectResponse[]
	/** Whether the bet is "active" (signal, proposed, active). The "No bet" lane is treated as active. */
	isActive: boolean
}

export interface WorkBoardModel {
	swimlanes: BoardSwimlane[]
	columnStatuses: string[]
	totalTasks: number
}

export interface UseWorkBoardResult {
	board: WorkBoardModel
	isLoading: boolean
	error: Error | null
}

function getTaskColumnStatuses(workspaceStatuses: string[] | undefined): string[] {
	if (!workspaceStatuses || workspaceStatuses.length === 0) return DEFAULT_COLUMN_STATUSES
	const filtered = workspaceStatuses.filter((s) => s !== BLOCKED_STATUS)
	return filtered.length > 0 ? filtered : DEFAULT_COLUMN_STATUSES
}

function emptyColumns(statuses: string[]): Record<string, ObjectResponse[]> {
	const cols: Record<string, ObjectResponse[]> = {}
	for (const status of statuses) cols[status] = []
	return cols
}

/**
 * Composes bets, tasks, and any bet↔task relationship (regardless of type or
 * direction) into the board model. Tasks without a parent bet land in a
 * synthetic "No bet" swimlane at the bottom. `blocked` tasks live in a
 * separate band per swimlane, never in a column.
 */
export function useWorkBoard(): UseWorkBoardResult {
	const { workspaceId, workspace } = useWorkspace()
	const betsQuery = useBets(workspaceId)
	const tasksQuery = useObjects(workspaceId, { type: 'task' })
	const relationshipsQuery = useRelationships(workspaceId)

	const settings = workspace.settings as { statuses?: { task?: string[] } } | undefined
	const columnStatuses = getTaskColumnStatuses(settings?.statuses?.task)

	const board = useMemo<WorkBoardModel>(() => {
		const bets = betsQuery.data ?? []
		const tasks = tasksQuery.data ?? []
		const relationships = relationshipsQuery.data ?? []

		const betById = new Map<string, ObjectResponse>()
		for (const bet of bets) betById.set(bet.id, bet)

		const taskIdToBetId = new Map<string, string>()
		for (const rel of relationships) {
			let betId: string | undefined
			let taskId: string | undefined
			if (rel.sourceType === 'bet' && rel.targetType === 'task') {
				betId = rel.sourceId
				taskId = rel.targetId
			} else if (rel.sourceType === 'task' && rel.targetType === 'bet') {
				betId = rel.targetId
				taskId = rel.sourceId
			} else {
				continue
			}
			if (!betById.has(betId)) continue
			if (!taskIdToBetId.has(taskId)) {
				taskIdToBetId.set(taskId, betId)
			}
		}

		const lanes = new Map<string, BoardSwimlane>()
		for (const bet of bets) {
			lanes.set(bet.id, {
				bet,
				columns: emptyColumns(columnStatuses),
				blocked: [],
				isActive: (ACTIVE_BET_STATUSES as readonly string[]).includes(bet.status),
			})
		}
		const noBetLane: BoardSwimlane = {
			bet: null,
			columns: emptyColumns(columnStatuses),
			blocked: [],
			isActive: true,
		}

		for (const task of tasks) {
			const parentBetId = taskIdToBetId.get(task.id)
			const lane =
				parentBetId && lanes.has(parentBetId)
					? (lanes.get(parentBetId) as BoardSwimlane)
					: noBetLane

			if (task.status === BLOCKED_STATUS) {
				lane.blocked.push(task)
				continue
			}
			const column = lane.columns[task.status]
			if (column) {
				column.push(task)
			} else {
				// Status outside the configured column list (e.g., a status removed from
				// the workspace settings after tasks were created). Drop it in backlog
				// so the user still sees it, rather than silently hiding it.
				const fallback = lane.columns.backlog ?? lane.columns[columnStatuses[0]]
				if (fallback) fallback.push(task)
			}
		}

		const orderedLanes: BoardSwimlane[] = []
		for (const bet of bets) {
			if ((ACTIVE_BET_STATUSES as readonly string[]).includes(bet.status)) {
				const lane = lanes.get(bet.id)
				if (lane) orderedLanes.push(lane)
			}
		}
		for (const bet of bets) {
			if ((INACTIVE_BET_STATUSES as readonly string[]).includes(bet.status)) {
				const lane = lanes.get(bet.id)
				if (lane) orderedLanes.push(lane)
			}
		}
		const hasNoBetTasks =
			noBetLane.blocked.length > 0 || Object.values(noBetLane.columns).some((col) => col.length > 0)
		if (hasNoBetTasks) orderedLanes.push(noBetLane)

		return {
			swimlanes: orderedLanes,
			columnStatuses,
			totalTasks: tasks.length,
		}
	}, [betsQuery.data, tasksQuery.data, relationshipsQuery.data, columnStatuses])

	return {
		board,
		isLoading: betsQuery.isLoading || tasksQuery.isLoading || relationshipsQuery.isLoading,
		error:
			(betsQuery.error as Error | null) ??
			(tasksQuery.error as Error | null) ??
			(relationshipsQuery.error as Error | null) ??
			null,
	}
}
