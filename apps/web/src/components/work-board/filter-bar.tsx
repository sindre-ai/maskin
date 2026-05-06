import { Badge } from '@/components/ui/badge'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { type WorkBoardFilters, isAssigneeKeyword } from '@/components/work-board/filters'
import { useActors } from '@/hooks/use-actors'
import { useBets } from '@/hooks/use-bets'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { X } from 'lucide-react'

interface FilterBarProps {
	filters: WorkBoardFilters
	onChange: (next: WorkBoardFilters) => void
}

/**
 * Sticky filter bar above the board. Each control writes back into URL state
 * via `onChange` (the route component owns the navigation). Active filters
 * also render as removable chips so the current view is legible at a glance.
 */
export function FilterBar({ filters, onChange }: FilterBarProps) {
	const { workspaceId } = useWorkspace()
	const { data: bets } = useBets(workspaceId)
	const { data: actors } = useActors(workspaceId)

	const setBet = (value: string) => onChange({ ...filters, bet: value || undefined })
	const setAssignee = (value: string) => onChange({ ...filters, assignee: value || undefined })
	const setStatus = (value: string) =>
		onChange({
			...filters,
			status: value === 'all' || !value ? undefined : (value as 'blocked' | 'active'),
		})

	const removeBet = () => onChange({ ...filters, bet: undefined })
	const removeAssignee = () => onChange({ ...filters, assignee: undefined })
	const removeStatus = () => onChange({ ...filters, status: undefined })

	const activeBet = filters.bet ? bets?.find((b) => b.id === filters.bet) : null
	const activeAssigneeLabel = filters.assignee
		? formatAssigneeLabel(filters.assignee, actors)
		: null
	const activeStatusLabel = formatStatusLabel(filters.status)

	return (
		<div
			className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-bg-surface px-4 py-2"
			data-testid="work-filter-bar"
		>
			<Select
				value={filters.bet ?? '__all__'}
				onValueChange={(v) => setBet(v === '__all__' ? '' : v)}
			>
				<SelectTrigger className="w-44" aria-label="Filter by bet">
					<SelectValue placeholder="All bets" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="__all__">All bets</SelectItem>
					{bets?.map((bet) => (
						<SelectItem key={bet.id} value={bet.id}>
							{bet.title || 'Untitled bet'}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<Select
				value={filters.assignee ?? '__all__'}
				onValueChange={(v) => setAssignee(v === '__all__' ? '' : v)}
			>
				<SelectTrigger className="w-44" aria-label="Filter by assignee">
					<SelectValue placeholder="Anyone" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="__all__">Anyone</SelectItem>
					<SelectItem value="mine">Mine</SelectItem>
					<SelectItem value="humans">All humans</SelectItem>
					<SelectItem value="agents">All agents</SelectItem>
					{actors?.map((actor) => (
						<SelectItem key={actor.id} value={actor.id}>
							{actor.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<Select value={filters.status ?? 'all'} onValueChange={setStatus}>
				<SelectTrigger className="w-32" aria-label="Filter by status">
					<SelectValue placeholder="All statuses" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="all">All statuses</SelectItem>
					<SelectItem value="active">Active</SelectItem>
					<SelectItem value="blocked">Blocked</SelectItem>
				</SelectContent>
			</Select>

			<div className="flex flex-wrap items-center gap-1.5 ml-1">
				{activeBet && (
					<FilterChip label={`Bet: ${activeBet.title || 'Untitled bet'}`} onRemove={removeBet} />
				)}
				{filters.assignee && activeAssigneeLabel && (
					<FilterChip label={`Assignee: ${activeAssigneeLabel}`} onRemove={removeAssignee} />
				)}
				{activeStatusLabel && (
					<FilterChip label={`Status: ${activeStatusLabel}`} onRemove={removeStatus} />
				)}
			</div>
		</div>
	)
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
	return (
		<button
			type="button"
			onClick={onRemove}
			aria-label={`Remove filter: ${label}`}
			className="appearance-none bg-transparent border-0 p-0"
		>
			<Badge
				variant="secondary"
				className={cn('gap-1 pr-1 cursor-pointer hover:bg-bg-hover transition-colors font-normal')}
			>
				<span className="truncate max-w-[14rem]">{label}</span>
				<X size={12} className="shrink-0" aria-hidden />
			</Badge>
		</button>
	)
}

function formatAssigneeLabel(value: string, actors: { id: string; name: string }[] | undefined) {
	if (isAssigneeKeyword(value)) {
		if (value === 'mine') return 'Mine'
		if (value === 'humans') return 'All humans'
		return 'All agents'
	}
	const actor = actors?.find((a) => a.id === value)
	return actor?.name ?? 'Unknown'
}

function formatStatusLabel(status: WorkBoardFilters['status']): string | null {
	if (!status || status === 'all') return null
	if (status === 'blocked') return 'Blocked'
	return 'Active'
}
