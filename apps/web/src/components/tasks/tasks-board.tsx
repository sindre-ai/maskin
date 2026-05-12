import { EmptyState } from '@/components/shared/empty-state'
import { TaskKanbanCard } from '@/components/tasks/task-kanban-card'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Check, SlidersHorizontal } from 'lucide-react'
import { useMemo, useState } from 'react'

type GroupBy = 'status' | 'owner' | 'priority'
type SortBy = 'updated' | 'priority' | 'title'
type Density = 'comfy' | 'compact'

interface Column {
	key: string
	label: string
}

const STATUS_COLUMNS: Column[] = [
	{ key: 'in_progress', label: 'In progress' },
	{ key: 'review', label: 'Review' },
	{ key: 'blocked', label: 'Blocked' },
	{ key: 'todo', label: 'To do' },
	{ key: 'done', label: 'Done' },
]

const PRIORITY_COLUMNS: Column[] = [
	{ key: 'high', label: 'High' },
	{ key: 'med', label: 'Medium' },
	{ key: 'low', label: 'Low' },
]

const STATUS_DOT_COLORS: Record<string, string> = {
	in_progress: 'bg-status-in_progress-text',
	review: 'bg-status-processing-text',
	blocked: 'bg-status-blocked-text',
	todo: 'bg-status-todo-text',
	done: 'bg-status-done-text',
}

interface TasksBoardProps {
	tasks: ObjectResponse[]
	bets: ObjectResponse[]
}

export function TasksBoard({ tasks, bets }: TasksBoardProps) {
	const [groupBy, setGroupBy] = useState<GroupBy>('status')
	const [hideDone, setHideDone] = useState(true)
	const [sortBy, setSortBy] = useState<SortBy>('updated')
	const [density, setDensity] = useState<Density>('comfy')
	const [viewOpen, setViewOpen] = useState(false)

	const betById = useMemo(() => new Map(bets.map((b) => [b.id, b])), [bets])

	const filteredTasks = useMemo(
		() => tasks.filter((t) => !(hideDone && t.status === 'done')),
		[tasks, hideDone],
	)

	const stats = useMemo(() => {
		return {
			inProgress: tasks.filter((t) => t.status === 'in_progress').length,
			review: tasks.filter((t) => t.status === 'review').length,
			blocked: tasks.filter((t) => t.status === 'blocked').length,
			todo: tasks.filter((t) => t.status === 'todo').length,
		}
	}, [tasks])

	const columns = useMemo<Column[]>(() => {
		if (groupBy === 'status') {
			return hideDone ? STATUS_COLUMNS.filter((c) => c.key !== 'done') : STATUS_COLUMNS
		}
		if (groupBy === 'priority') return PRIORITY_COLUMNS
		if (groupBy === 'owner') {
			const owners = [...new Set(filteredTasks.map((t) => t.owner ?? ''))].filter(Boolean)
			const hasUnassigned = filteredTasks.some((t) => !t.owner)
			const cols = owners.map((o) => ({ key: o, label: o }))
			if (hasUnassigned) cols.push({ key: '', label: 'Unassigned' })
			return cols
		}
		return []
	}, [groupBy, hideDone, filteredTasks])

	const tasksByColumn = useMemo(() => {
		const map = new Map<string, ObjectResponse[]>()
		for (const col of columns) {
			map.set(col.key, [])
		}
		for (const task of filteredTasks) {
			let colKey: string
			if (groupBy === 'status') colKey = task.status
			else if (groupBy === 'owner') colKey = task.owner ?? ''
			else colKey = (task.metadata?.priority as string | undefined) ?? 'med'

			const existing = map.get(colKey)
			if (existing) existing.push(task)
		}

		// Sort within each column
		for (const [key, items] of map) {
			map.set(
				key,
				items.sort((a, b) => {
					if (sortBy === 'updated') {
						return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
					}
					if (sortBy === 'priority') {
						const order = { high: 0, med: 1, low: 2 }
						const ap = (a.metadata?.priority as string | undefined) ?? 'med'
						const bp = (b.metadata?.priority as string | undefined) ?? 'med'
						return (order[ap as keyof typeof order] ?? 1) - (order[bp as keyof typeof order] ?? 1)
					}
					return (a.title ?? '').localeCompare(b.title ?? '')
				}),
			)
		}
		return map
	}, [columns, filteredTasks, groupBy, sortBy])

	// Find parent bet for a task via metadata
	const getParentBet = (task: ObjectResponse) => {
		const betId = task.metadata?.bet_id as string | undefined
		if (!betId) return undefined
		return betById.get(betId)
	}

	const groupLabels: Record<GroupBy, string> = {
		status: 'Status',
		owner: 'Owner',
		priority: 'Priority',
	}

	if (tasks.length === 0) {
		return (
			<EmptyState
				title="No tasks yet"
				description="Tasks are created by agents when breaking down bets into concrete work."
			/>
		)
	}

	return (
		<div className="flex flex-col gap-0">
			{/* One-line overview */}
			<div className="flex items-baseline gap-2.5 py-2.5 border-b border-border text-[13px] text-text-secondary mb-0">
				<span>
					<span
						className={cn(
							'font-semibold tabular-nums text-sm',
							stats.inProgress > 0 ? 'text-accent' : 'text-text',
						)}
					>
						{stats.inProgress}
					</span>{' '}
					in progress
				</span>
				<span className="text-border opacity-60">·</span>
				<span>
					<span className="font-semibold tabular-nums text-sm text-text">{stats.review}</span> need
					review
				</span>
				<span className="text-border opacity-60">·</span>
				<span className={cn(stats.blocked > 0 && 'text-error')}>
					<span
						className={cn(
							'font-semibold tabular-nums text-sm',
							stats.blocked > 0 ? 'text-error' : 'text-text',
						)}
					>
						{stats.blocked}
					</span>{' '}
					blocked
				</span>
				<span className="text-border opacity-60">·</span>
				<span className="text-text-muted">
					<span className="font-semibold tabular-nums text-sm text-text-secondary">
						{stats.todo}
					</span>{' '}
					queued
				</span>
			</div>

			{/* Toolbar */}
			<div className="flex items-center gap-1 py-3 mb-4 border-b border-border">
				{/* Group-by segmented control */}
				<div className="flex items-center gap-0.5">
					{(['status', 'owner', 'priority'] as GroupBy[]).map((g) => (
						<button
							key={g}
							type="button"
							onClick={() => setGroupBy(g)}
							className={cn(
								'px-2.5 py-1 text-xs rounded-md font-medium transition-colors duration-150',
								groupBy === g
									? 'bg-bg-hover text-text font-semibold'
									: 'text-text-muted hover:bg-bg-hover hover:text-text',
							)}
						>
							{groupLabels[g]}
						</button>
					))}
				</div>

				<span className="flex-1" />

				{/* Hide done toggle */}
				<button
					type="button"
					onClick={() => setHideDone((v) => !v)}
					className={cn(
						'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md font-medium transition-colors duration-150',
						hideDone
							? 'bg-bg-hover text-text'
							: 'text-text-muted hover:bg-bg-hover hover:text-text',
					)}
				>
					{hideDone ? '●' : '○'} Hide done
				</button>

				{/* View popover (sort + density) */}
				<Popover open={viewOpen} onOpenChange={setViewOpen}>
					<PopoverTrigger asChild>
						<button
							type="button"
							className={cn(
								'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md font-medium transition-colors duration-150',
								'text-text-muted hover:bg-bg-hover hover:text-text',
							)}
						>
							<SlidersHorizontal size={11} />
							View
						</button>
					</PopoverTrigger>
					<PopoverContent align="end" className="w-52 p-0">
						<div className="p-3 border-b border-border">
							<p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted mb-2">
								Sort
							</p>
							<div className="flex flex-col gap-0.5">
								{(
									[
										['updated', 'Recent activity'],
										['priority', 'Priority'],
										['title', 'Title'],
									] as [SortBy, string][]
								).map(([key, label]) => (
									<button
										key={key}
										type="button"
										onClick={() => {
											setSortBy(key)
											setViewOpen(false)
										}}
										className={cn(
											'flex items-center justify-between px-2 py-1.5 text-xs rounded-md font-medium transition-colors',
											'hover:bg-bg-hover',
											sortBy === key ? 'text-text' : 'text-text-secondary',
										)}
									>
										{label}
										{sortBy === key && <Check size={12} className="text-accent" />}
									</button>
								))}
							</div>
						</div>
						<div className="p-3">
							<p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted mb-2">
								Density
							</p>
							<div className="flex gap-1.5">
								{(['comfy', 'compact'] as Density[]).map((d) => (
									<button
										key={d}
										type="button"
										onClick={() => setDensity(d)}
										className={cn(
											'flex-1 py-1.5 text-xs rounded-md font-medium transition-colors capitalize',
											density === d ? 'bg-bg-hover text-text' : 'text-text-muted hover:bg-bg-hover',
										)}
									>
										{d}
									</button>
								))}
							</div>
						</div>
					</PopoverContent>
				</Popover>
			</div>

			{/* Kanban grid */}
			<div
				className={cn(
					'grid gap-4',
					columns.length <= 2 && 'grid-cols-2',
					columns.length === 3 && 'grid-cols-3',
					columns.length >= 4 && 'grid-cols-[repeat(auto-fill,minmax(200px,1fr))]',
				)}
			>
				{columns.map((col) => {
					const items = tasksByColumn.get(col.key) ?? []
					const dotColor = STATUS_DOT_COLORS[col.key]

					return (
						<div key={col.key} className="flex flex-col gap-2.5 min-w-0">
							{/* Column header */}
							<div className="flex items-center gap-2 pb-1.5 border-b border-border">
								{groupBy === 'status' && dotColor && (
									<span className={cn('h-1.5 w-1.5 rounded-full shrink-0', dotColor)} />
								)}
								<span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-text">
									{col.label}
								</span>
								<span className="text-[11px] text-text-muted font-medium">{items.length}</span>
							</div>

							{/* Cards */}
							<div className="flex flex-col gap-0.5">
								{items.length === 0 && (
									<p className="px-2.5 py-1 text-[12.5px] text-text-muted italic">—</p>
								)}
								{items.map((task) => {
									const parent = getParentBet(task)
									return (
										<TaskKanbanCard
											key={task.id}
											task={task}
											parentTitle={parent?.title ?? undefined}
											hideParent={groupBy === 'owner'}
											hideOwner={groupBy === 'owner'}
											compact={density === 'compact'}
										/>
									)
								})}
							</div>
						</div>
					)
				})}
			</div>
		</div>
	)
}
