import { PageHeader } from '@/components/layout/page-header'
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
import { useCustomExtensions } from '@/hooks/use-custom-extensions'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useObjects } from '@/hooks/use-objects'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledObjectTypeTabs } from '@ai-native/module-sdk'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/objects/')({
	component: ObjectsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ObjectsPage() {
	const { workspaceId, workspace } = useWorkspace()
	const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined)
	const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)
	const [ownerFilter, setOwnerFilter] = useState<string | undefined>(undefined)
	const [search, setSearch] = useState('')
	const { data: actors } = useActors(workspaceId)
	const enabledModules = useEnabledModules()
	const customExtensions = useCustomExtensions()
	const settings = workspace.settings as Record<string, unknown>

	const tabs = useMemo(() => {
		const moduleTabs = getEnabledObjectTypeTabs(enabledModules)
		const customTabs = customExtensions.filter((ext) => ext.enabled).flatMap((ext) => ext.tabs)
		return [
			{ label: 'All', value: undefined as string | undefined },
			...moduleTabs.map((t) => ({ label: t.label, value: t.value as string | undefined })),
			...customTabs.map((t) => ({ label: t.label, value: t.value as string | undefined })),
		]
	}, [enabledModules, customExtensions])

	const filters: Record<string, string> = {}
	if (typeFilter) filters.type = typeFilter
	if (statusFilter) filters.status = statusFilter
	if (ownerFilter) filters.owner = ownerFilter

	const { data: objects, isLoading } = useObjects(workspaceId, filters)

	// Derive available statuses for the current type filter
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

			{isLoading ? <ListSkeleton /> : <ObjectList objects={filtered} workspaceId={workspaceId} />}
		</div>
	)
}
