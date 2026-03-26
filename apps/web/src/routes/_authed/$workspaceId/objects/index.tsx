import { PageHeader } from '@/components/layout/page-header'
import { ObjectForm } from '@/components/objects/object-form'
import { ObjectHierarchy } from '@/components/objects/object-hierarchy'
import { ObjectRow } from '@/components/objects/object-row'
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
import { useObjectTypes } from '@/hooks/use-object-types'
import { useObjects } from '@/hooks/use-objects'
import { useRelationships } from '@/hooks/use-relationships'
import { useSessions } from '@/hooks/use-sessions'
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

function ObjectsPage() {
	const { workspaceId } = useWorkspace()
	const objectTypes = useObjectTypes()
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

	// Fetch relationships only when showing the All tab (for hierarchy)
	const { data: relationships } = useRelationships(workspaceId)
	const { data: sessions } = useSessions(workspaceId)
	const sessionMap = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s])), [sessions])

	// Derive available statuses for the current type filter
	const allStatuses = useMemo(() => {
		if (typeFilter) {
			return objectTypes.find((t) => t.slug === typeFilter)?.statuses ?? []
		}
		return [...new Set(objectTypes.flatMap((t) => t.statuses))]
	}, [objectTypes, typeFilter])

	const filtered = search
		? (objects ?? []).filter(
				(o) =>
					o.title?.toLowerCase().includes(search.toLowerCase()) ||
					o.content?.toLowerCase().includes(search.toLowerCase()),
			)
		: (objects ?? [])

	// Group by status for type-specific tabs
	const groupedByStatus = useMemo(() => {
		if (!typeFilter) return null
		const groups = new Map<string, typeof filtered>()
		for (const o of filtered) {
			const arr = groups.get(o.status ?? '') ?? []
			arr.push(o)
			groups.set(o.status ?? '', arr)
		}
		return groups
	}, [filtered, typeFilter])

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
				<div className="flex gap-1 flex-wrap">
					<button
						type="button"
						className={cn(
							'rounded px-3 py-1 text-sm',
							typeFilter === undefined
								? 'bg-muted text-foreground font-medium'
								: 'text-muted-foreground hover:text-foreground',
						)}
						onClick={() => {
							setTypeFilter(undefined)
							setStatusFilter(undefined)
						}}
					>
						All
					</button>
					{objectTypes.map((t) => (
						<button
							key={t.slug}
							type="button"
							className={cn(
								'rounded px-3 py-1 text-sm',
								typeFilter === t.slug
									? 'bg-muted text-foreground font-medium'
									: 'text-muted-foreground hover:text-foreground',
							)}
							onClick={() => {
								setTypeFilter(t.slug)
								setStatusFilter(undefined)
							}}
						>
							{t.display_name}
						</button>
					))}
				</div>
				<Select
					value={statusFilter ?? '__all__'}
					onValueChange={(v) => setStatusFilter(v === '__all__' ? undefined : v)}
				>
					<SelectTrigger>
						<SelectValue placeholder="Any status" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="__all__">Any status</SelectItem>
						{allStatuses.map((s) => (
							<SelectItem key={s} value={s}>
								{s.replace(/_/g, ' ')}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={ownerFilter ?? '__all__'}
					onValueChange={(v) => setOwnerFilter(v === '__all__' ? undefined : v)}
				>
					<SelectTrigger>
						<SelectValue placeholder="Any owner" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="__all__">Any owner</SelectItem>
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

			{isLoading ? (
				<ListSkeleton />
			) : typeFilter === undefined ? (
				// All tab: hierarchical view
				<ObjectHierarchy
					objects={objects ?? []}
					relationships={relationships ?? []}
					workspaceId={workspaceId}
					search={search}
					sessionMap={sessionMap}
				/>
			) : groupedByStatus && groupedByStatus.size > 0 ? (
				// Type-specific tabs: grouped by status
				<div>
					{[...groupedByStatus.entries()].map(([status, items]) => (
						<div key={status} className="mb-4">
							<div className="flex items-center gap-2 py-2 px-3">
								<span className="text-xs font-semibold text-foreground capitalize">
									{status.replace(/_/g, ' ') || 'No status'}
								</span>
								<span className="text-xs text-muted-foreground">{items.length}</span>
								<div className="flex-1 h-px bg-border" />
							</div>
							<div className="divide-y divide-border">
								{items.map((o) => (
									<ObjectRow
										key={o.id}
										object={o}
										workspaceId={workspaceId}
										sessionMap={sessionMap}
									/>
								))}
							</div>
						</div>
					))}
				</div>
			) : (
				// Type tab but no results
				<div className="divide-y divide-border">
					{filtered.map((o) => (
						<ObjectRow key={o.id} object={o} workspaceId={workspaceId} sessionMap={sessionMap} />
					))}
				</div>
			)}
		</div>
	)
}
