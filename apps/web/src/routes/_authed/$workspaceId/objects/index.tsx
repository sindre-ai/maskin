import { ImportDialog } from '@/components/imports/import-dialog'
import { PageHeader } from '@/components/layout/page-header'
import { type ObjectsTableMeta, getStaticColumns } from '@/components/objects/data-table/columns'
import { DataTable } from '@/components/objects/data-table/data-table'
import type { ColumnInfo } from '@/components/objects/data-table/data-table-controls'
import { DataTableToolbar } from '@/components/objects/data-table/data-table-toolbar'
import { getDynamicColumns } from '@/components/objects/data-table/dynamic-columns'
import { RouteError } from '@/components/shared/route-error'
import { useActors } from '@/hooks/use-actors'
import { useCustomExtensions } from '@/hooks/use-custom-extensions'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useImportToast } from '@/hooks/use-imports'
import { useUpdateObject } from '@/hooks/use-objects'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import type { GroupingState, RowSelectionState, VisibilityState } from '@tanstack/react-table'
import { useCallback, useMemo, useRef, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/objects/')({
	component: ObjectsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>) => ({
		type: typeof search.type === 'string' ? search.type : undefined,
		status: typeof search.status === 'string' ? search.status : undefined,
		owner: typeof search.owner === 'string' ? search.owner : undefined,
		sort: typeof search.sort === 'string' ? search.sort : 'createdAt',
		order:
			typeof search.order === 'string' && ['asc', 'desc'].includes(search.order)
				? (search.order as 'asc' | 'desc')
				: 'desc',
		q: typeof search.q === 'string' ? search.q : undefined,
		groupBy: typeof search.groupBy === 'string' ? search.groupBy : undefined,
	}),
})

const PAGE_SIZE = 50

function ObjectsPage() {
	const { workspaceId, workspace } = useWorkspace()
	const navigate = useNavigate()
	const searchParams = useSearch({ from: '/_authed/$workspaceId/objects/' })
	const {
		type: typeFilter,
		status: statusFilter,
		owner: ownerFilter,
		sort,
		order,
		q,
		groupBy,
	} = searchParams

	const [importOpen, setImportOpen] = useState(false)
	const { startTracking: trackImport } = useImportToast(workspaceId)
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
		createdBy: false,
	})

	const searchParamsRef = useRef(searchParams)
	searchParamsRef.current = searchParams

	const { data: actors } = useActors(workspaceId)
	const enabledModules = useEnabledModules()
	const customExtensions = useCustomExtensions()
	const settings = workspace.settings as Record<string, unknown>

	// Build tabs
	const tabs = useMemo(() => {
		const moduleTabs = getEnabledObjectTypeTabs(enabledModules)
		const customTabs = customExtensions.filter((ext) => ext.enabled).flatMap((ext) => ext.tabs)
		return [
			{ label: 'All', value: undefined as string | undefined },
			...moduleTabs.map((t) => ({ label: t.label, value: t.value as string | undefined })),
			...customTabs.map((t) => ({ label: t.label, value: t.value as string | undefined })),
		]
	}, [enabledModules, customExtensions])

	// Build API filters
	const filters = useMemo(() => {
		const f: Record<string, string> = {}
		if (typeFilter) f.type = typeFilter
		if (statusFilter) f.status = statusFilter
		if (ownerFilter) f.owner = ownerFilter
		f.sort = sort
		f.order = order
		return f
	}, [typeFilter, statusFilter, ownerFilter, sort, order])

	// Infinite query — use search endpoint when q is present
	const infiniteQuery = useInfiniteQuery({
		queryKey: queryKeys.objects.listInfinite(workspaceId, { ...filters, q }),
		queryFn: ({ pageParam }) => {
			const params: Record<string, string> = {
				...filters,
				limit: String(PAGE_SIZE),
				offset: String(pageParam),
			}
			if (q) {
				params.q = q
				return api.objects.search(workspaceId, params)
			}
			return api.objects.list(workspaceId, params)
		},
		getNextPageParam: (lastPage, allPages) => {
			if (lastPage.length < PAGE_SIZE) return undefined
			return allPages.flat().length
		},
		initialPageParam: 0,
	})

	const allObjects = useMemo(() => infiniteQuery.data?.pages.flat() ?? [], [infiniteQuery.data])

	// Derive available statuses grouped by type (scoped to enabled types only)
	const statusesByType = useMemo(() => {
		const statusMap = settings?.statuses as Record<string, string[]> | undefined
		if (!statusMap) return {}
		if (typeFilter) return { [typeFilter]: statusMap[typeFilter] ?? [] }
		const enabledTypes = new Set(tabs.map((t) => t.value).filter(Boolean))
		return Object.fromEntries(Object.entries(statusMap).filter(([type]) => enabledTypes.has(type)))
	}, [settings, typeFilter, tabs])

	// Field definitions for dynamic columns
	const fieldDefinitions = settings?.field_definitions as
		| Record<string, Array<{ name: string; type: 'text' | 'number' | 'date' | 'enum' | 'boolean' }>>
		| undefined

	// Update search params helper — uses ref to stay stable across param changes
	const updateSearch = useCallback(
		(updates: Record<string, string | undefined>) => {
			const next: Record<string, unknown> = { ...searchParamsRef.current, ...updates }
			for (const key of Object.keys(next)) {
				if (next[key] === undefined || next[key] === '') delete next[key]
			}
			navigate({
				to: '/$workspaceId/objects',
				params: { workspaceId },
				search: next as typeof searchParams,
				replace: true,
			})
		},
		[navigate, workspaceId],
	)

	const updateObject = useUpdateObject(workspaceId)

	const handleToggleStar = useCallback(
		(id: string, isStarred: boolean) => {
			updateObject.mutate({ id, data: { isStarred } })
		},
		[updateObject],
	)

	// Sort handler for column headers
	const handleSort = useCallback(
		(columnId: string) => {
			if (sort === columnId) {
				updateSearch({ order: order === 'asc' ? 'desc' : 'asc' })
			} else {
				updateSearch({ sort: columnId, order: 'desc' })
			}
		},
		[sort, order, updateSearch],
	)

	// Table meta — sort state passed via meta to avoid re-creating columns on every sort change
	const tableMeta: ObjectsTableMeta = useMemo(
		() => ({
			onSort: handleSort,
			currentSort: sort,
			currentOrder: order,
			onToggleStar: handleToggleStar,
		}),
		[handleSort, sort, order, handleToggleStar],
	)

	// Columns — stable across sort changes since sort state is in meta
	const columns = useMemo(
		() => [
			...getStaticColumns({
				workspaceId,
				actors,
			}),
			...getDynamicColumns(fieldDefinitions, typeFilter),
		],
		[workspaceId, actors, fieldDefinitions, typeFilter],
	)

	// Column info for the controls popover
	const columnInfo: ColumnInfo[] = useMemo(() => {
		const staticNames: Record<string, string> = {
			status: 'Status',
			type: 'Type',
			owner: 'Owner',
			createdBy: 'Created by',
			createdAt: 'Created',
			updatedAt: 'Updated',
		}
		return columns
			.filter((col) => {
				const id = 'accessorKey' in col ? String(col.accessorKey) : col.id
				return id !== 'select'
			})
			.map((col) => {
				const id = 'accessorKey' in col ? String(col.accessorKey) : (col.id ?? '')
				const canHide = col.enableHiding !== false && id !== 'title'
				const label = id.startsWith('metadata.')
					? id.slice(9).replace(/_/g, ' ')
					: (staticNames[id] ?? id)
				return { id, label, canHide }
			})
	}, [columns])

	// Grouping state
	const groupingState: GroupingState = groupBy ? [groupBy] : []

	// Hide dynamic columns by default when in "All" tab
	const effectiveVisibility = useMemo(() => {
		const vis = { ...columnVisibility }
		if (!typeFilter && fieldDefinitions) {
			const allFields = Object.values(fieldDefinitions).flat()
			for (const field of allFields) {
				const colId = `metadata.${field.name}`
				if (!(colId in vis)) {
					vis[colId] = false
				}
			}
		}
		return vis
	}, [columnVisibility, typeFilter, fieldDefinitions])

	const handleColumnVisibilityChange = useCallback((columnId: string, visible: boolean) => {
		setColumnVisibility((prev) => ({ ...prev, [columnId]: visible }))
	}, [])

	return (
		<div>
			<PageHeader title="Objects" />

			<DataTableToolbar
				columns={columnInfo}
				columnVisibility={effectiveVisibility}
				onColumnVisibilityChange={handleColumnVisibilityChange}
				tabs={tabs}
				typeFilter={typeFilter}
				onTypeFilterChange={(value) => updateSearch({ type: value, status: undefined })}
				search={q}
				onSearchChange={(value) => updateSearch({ q: value || undefined })}
				statusFilter={statusFilter}
				onStatusFilterChange={(value) => updateSearch({ status: value })}
				statusesByType={statusesByType}
				ownerFilter={ownerFilter}
				onOwnerFilterChange={(value) => updateSearch({ owner: value })}
				actors={actors}
				sort={sort}
				onSortChange={(value) => updateSearch({ sort: value })}
				order={order}
				onOrderChange={(value) => updateSearch({ order: value })}
				groupBy={groupBy}
				onGroupByChange={(value) => updateSearch({ groupBy: value })}
				onImportClick={() => setImportOpen(true)}
			/>

			<ImportDialog open={importOpen} onOpenChange={setImportOpen} onImportStarted={trackImport} />

			<DataTable
				data={allObjects}
				columns={columns}
				workspaceId={workspaceId}
				rowSelection={rowSelection}
				onRowSelectionChange={setRowSelection}
				columnVisibility={effectiveVisibility}
				onColumnVisibilityChange={setColumnVisibility}
				grouping={groupingState}
				meta={tableMeta}
				hasNextPage={infiniteQuery.hasNextPage}
				isFetchingNextPage={infiniteQuery.isFetchingNextPage}
				isError={infiniteQuery.isError}
				fetchNextPage={infiniteQuery.fetchNextPage}
				isLoading={infiniteQuery.isLoading}
			/>
		</div>
	)
}
