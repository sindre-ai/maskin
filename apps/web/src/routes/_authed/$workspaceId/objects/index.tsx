import { PageHeader } from '@/components/layout/page-header'
import { ObjectForm } from '@/components/objects/object-form'
import { ObjectList } from '@/components/objects/object-list'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useActors } from '@/hooks/use-actors'
import { useObjects } from '@/hooks/use-objects'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/objects/')({
	component: ObjectsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>) => ({
		create: search.create === 'true' || search.create === true,
	}),
})

const tabs = [
	{ label: 'All', value: undefined },
	{ label: 'Insights', value: 'insight' },
	{ label: 'Bets', value: 'bet' },
	{ label: 'Tasks', value: 'task' },
] as const

function ObjectsPage() {
	const { workspaceId, workspace } = useWorkspace()
	const { create } = useSearch({ from: '/_authed/$workspaceId/objects/' })
	const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined)
	const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)
	const [ownerFilter, setOwnerFilter] = useState<string | undefined>(undefined)
	const [search, setSearch] = useState('')
	const [showCreate, setShowCreate] = useState(false)
	const { data: actors } = useActors(workspaceId)

	// Open create form via Cmd+N keyboard shortcut
	useEffect(() => {
		if (create) setShowCreate(true)
	}, [create])

	const filters: Record<string, string> = {}
	if (typeFilter) filters.type = typeFilter
	if (statusFilter) filters.status = statusFilter
	if (ownerFilter) filters.owner = ownerFilter

	const { data: objects, isLoading } = useObjects(workspaceId, filters)

	// Derive available statuses for the current type filter
	const settings = workspace.settings as Record<string, unknown>
	const allStatuses = useMemo(() => {
		const statusMap = settings?.statuses as Record<string, string[]> | undefined
		if (!statusMap) return []
		if (typeFilter) return statusMap[typeFilter] ?? []
		return [...new Set(Object.values(statusMap).flat())]
	}, [settings, typeFilter])

	const filtered = search
		? (objects ?? []).filter(
				(o) =>
					o.title?.toLowerCase().includes(search.toLowerCase()) ||
					o.content?.toLowerCase().includes(search.toLowerCase()),
			)
		: (objects ?? [])

	return (
		<div>
			<PageHeader title="Objects" />

			{showCreate && (
				<div className="mb-6 rounded-lg border border-border bg-card p-4">
					<ObjectForm onClose={() => setShowCreate(false)} />
				</div>
			)}

			{/* Tabs + Filters */}
			<div className="flex items-center gap-4 mb-4 flex-wrap">
				<div className="flex gap-1">
					{tabs.map((tab) => (
						<button
							key={tab.label}
							type="button"
							className={cn(
								'rounded px-3 py-1 text-sm',
								typeFilter === tab.value
									? 'bg-muted text-foreground font-medium'
									: 'text-muted-foreground hover:text-foreground',
							)}
							onClick={() => {
								setTypeFilter(tab.value)
								setStatusFilter(undefined)
							}}
						>
							{tab.label}
						</button>
					))}
				</div>
				<Select
					value={statusFilter ?? ''}
					onValueChange={(v) => setStatusFilter(v || undefined)}
				>
					<SelectTrigger>
						<SelectValue placeholder="Any status" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="">Any status</SelectItem>
						{allStatuses.map((s) => (
							<SelectItem key={s} value={s}>
								{s.replace(/_/g, ' ')}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={ownerFilter ?? ''}
					onValueChange={(v) => setOwnerFilter(v || undefined)}
				>
					<SelectTrigger>
						<SelectValue placeholder="Any owner" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="">Any owner</SelectItem>
						{(actors ?? []).map((a) => (
							<SelectItem key={a.id} value={a.id}>
								{a.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<input
					type="text"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search..."
					className="rounded border border-border bg-card px-3 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring outline-none"
				/>
			</div>

			{isLoading ? <ListSkeleton /> : <ObjectList objects={filtered} workspaceId={workspaceId} />}
		</div>
	)
}
