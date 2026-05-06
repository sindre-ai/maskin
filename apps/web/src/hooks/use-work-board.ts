import {
	type WorkBoardFilters,
	actorTypeMap,
	hasActiveFilters,
	matchesFilters,
} from '@/components/work-board/filters'
import { useActors } from '@/hooks/use-actors'
import { useBets } from '@/hooks/use-bets'
import { useObjects } from '@/hooks/use-objects'
import { useRelationships } from '@/hooks/use-relationships'
import type { ObjectResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { useMemo } from 'react'

export const ACTIVE_BET_STATUSES = ['signal', 'proposed', 'active'] as const
export const INACTIVE_BET_STATUSES = ['completed', 'succeeded', 'failed', 'paused'] as const

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

export interface UseWorkBoardOptions {
	filters?: WorkBoardFilters
}

function getTaskColumnStatuses(workspaceStatuses: string[] | undefined): string[] {
	if (!workspaceStatuses || workspaceStatuses.length === 0) return DEFAULT_COLUMN_STATUSES
	return workspaceStatuses
}

function emptyColumns(statuses: string[]): Record<string, ObjectResponse[]> {
	const cols: Record<string, ObjectResponse[]> = {}
	for (const status of statuses) cols[status] = []
	return cols
}

/**
 * Composes bets, tasks, and any bet↔task relationship (regardless of type or
 * direction) into the board model. A task linked to multiple bets appears
 * under each of them. Tasks without a parent bet land in a synthetic "No bet"
 * swimlane at the bottom.
 */
export function useWorkBoard(options: UseWorkBoardOptions = {}): UseWorkBoardResult {
	const { workspaceId, workspace } = useWorkspace()
	const filters = options.filters ?? {}
	// Actors are only fetched if needed for assignee filtering — they're cached in
	// TanStack Query, so this is essentially free for any page that already loaded them.
	const needsActors = filters.assignee === 'humans' || filters.assignee === 'agents'
	const betsQuery = useBets(workspaceId)
	const tasksQuery = useObjects(workspaceId, { type: 'task' })
	const relationshipsQuery = useRelationships(workspaceId)
	const actorsQuery = useActors(workspaceId, { enabled: needsActors })

	const settings = workspace.settings as { statuses?: { task?: string[] } } | undefined
	const columnStatuses = getTaskColumnStatuses(settings?.statuses?.task)

	const board = useMemo<WorkBoardModel>(() => {
		const bets = betsQuery.data ?? []
		const tasks = tasksQuery.data ?? []
		const relationships = relationshipsQuery.data ?? []
		const filterContext = {
			currentActorId: getStoredActor()?.id ?? null,
			actorTypeById: actorTypeMap(actorsQuery.data),
		}
		const filtersActive = hasActiveFilters(filters)

		const betById = new Map<string, ObjectResponse>()
		for (const bet of bets) betById.set(bet.id, bet)

		const taskIdToBetIds = new Map<string, Set<string>>()
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
			let bets = taskIdToBetIds.get(taskId)
			if (!bets) {
				bets = new Set<string>()
				taskIdToBetIds.set(taskId, bets)
			}
			bets.add(betId)
		}

		const lanes = new Map<string, BoardSwimlane>()
		for (const bet of bets) {
			// `bet` filter is applied at the lane level: skip lane construction for
			// non-matching bets so downstream task placement is also a no-op.
			if (filters.bet && bet.id !== filters.bet) continue
			lanes.set(bet.id, {
				bet,
				columns: emptyColumns(columnStatuses),
				isActive: (ACTIVE_BET_STATUSES as readonly string[]).includes(bet.status),
			})
		}
		const noBetLane: BoardSwimlane = {
			bet: null,
			columns: emptyColumns(columnStatuses),
			isActive: true,
		}
		// The "No bet" lane only exists when no bet filter is active — otherwise the
		// user has asked for a specific bet and orphans aren't part of that view.
		const noBetLaneEnabled = !filters.bet

		const placeInLane = (lane: BoardSwimlane, task: ObjectResponse) => {
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

		for (const task of tasks) {
			if (!matchesFilters(task, filters, filterContext)) continue
			const parentBetIds = taskIdToBetIds.get(task.id)
			if (!parentBetIds || parentBetIds.size === 0) {
				if (noBetLaneEnabled) placeInLane(noBetLane, task)
				continue
			}
			for (const betId of parentBetIds) {
				const lane = lanes.get(betId)
				if (lane) placeInLane(lane, task)
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
		const hasNoBetTasks = Object.values(noBetLane.columns).some((col) => col.length > 0)
		if (noBetLaneEnabled && hasNoBetTasks) orderedLanes.push(noBetLane)

		// When any filter is active, hide lanes that no longer have matching tasks.
		// Without filters, empty lanes still render so an empty bet is visible at a glance.
		const visibleLanes = filtersActive
			? orderedLanes.filter((lane) => Object.values(lane.columns).some((col) => col.length > 0))
			: orderedLanes

		return {
			swimlanes: visibleLanes,
			columnStatuses,
			totalTasks: tasks.length,
		}
	}, [
		betsQuery.data,
		tasksQuery.data,
		relationshipsQuery.data,
		actorsQuery.data,
		columnStatuses,
		filters,
	])

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
