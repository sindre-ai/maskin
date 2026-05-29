import { ImportDialog } from '@/components/imports/import-dialog'
import { PageHeader } from '@/components/layout/page-header'
import { BulkActionBar } from '@/components/objects/bulk-action-bar'
import { type ObjectsTableMeta, getStaticColumns } from '@/components/objects/data-table/columns'
import { DataTable } from '@/components/objects/data-table/data-table'
import type { ColumnInfo } from '@/components/objects/data-table/data-table-controls'
import { DataTableToolbar } from '@/components/objects/data-table/data-table-toolbar'
import { getDynamicColumns } from '@/components/objects/data-table/dynamic-columns'
import { RouteError } from '@/components/shared/route-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useCustomExtensions } from '@/hooks/use-custom-extensions'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useImportToast } from '@/hooks/use-imports'
import { useBulkUpdateObjects } from '@/hooks/use-objects'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import { api } from '@/lib/api'
import type { DisplaySettingsBody, ObjectResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import {
	type InfiniteData,
	keepPreviousData,
	useInfiniteQuery,
	useQueryClient,
} from '@tanstack/react-query'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import type { GroupingState, RowSelectionState, VisibilityState } from '@tanstack/react-table'
import { Filter, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

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
		ids: typeof search.ids === 'string' ? search.ids : undefined,
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
		ids: idsFilter,
	} = searchParams

	const [importOpen, setImportOpen] = useState(false)
	const { startTracking: trackImport } = useImportToast(workspaceId)
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
		createdBy: false,
	})

	// Row selection keys are object IDs (data-table sets getRowId: row => row.id),
	// so we can lift them directly as the selection surface for sibling bulk-action UI.
	const selectedIds = useMemo(() => Object.keys(rowSelection), [rowSelection])
	const clearSelection = useCallback(() => setRowSelection({}), [])
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection whenever the active workspace changes
	useEffect(() => {
		setRowSelection({})
	}, [workspaceId])

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
		if (idsFilter) f.ids = idsFilter
		f.sort = sort
		f.order = order
		return f
	}, [typeFilter, statusFilter, ownerFilter, idsFilter, sort, order])

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
		placeholderData: keepPreviousData,
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
		() => ({ onSort: handleSort, currentSort: sort, currentOrder: order }),
		[handleSort, sort, order],
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

	// Per-actor display settings (persistence layer from Task 5).
	// Hydration policy: when the user lands on a tab with persisted settings
	// and the URL is in its default shape, apply the saved view. Once any
	// tracked field changes we write the whole blob back. The All tab is not
	// persisted because the persistence row is keyed by `object_type` —
	// there is no slot for "all types".
	const displaySettingsQuery = useUserDisplaySettings(workspaceId, typeFilter ?? '')
	const updateDisplaySettings = useUpdateUserDisplaySettings(workspaceId)
	// `useMutation` returns a new object reference on every render, but the
	// `mutate` function itself is stable. Pinning the stable callable into a
	// ref keeps the write-through effect's deps from changing on every render
	// — without that, the effect would re-arm its 500 ms timeout indefinitely
	// after the first write, producing a write-every-500 ms loop while the
	// page is open.
	const updateMutateRef = useRef(updateDisplaySettings.mutate)
	updateMutateRef.current = updateDisplaySettings.mutate
	const hydratedTypesRef = useRef<Set<string>>(new Set())

	const urlIsInDefaultShape = useMemo(
		() =>
			(!searchParams.sort || searchParams.sort === 'createdAt') &&
			(!searchParams.order || searchParams.order === 'desc') &&
			!searchParams.groupBy &&
			!searchParams.status &&
			!searchParams.owner,
		[
			searchParams.sort,
			searchParams.order,
			searchParams.groupBy,
			searchParams.status,
			searchParams.owner,
		],
	)

	useEffect(() => {
		if (!typeFilter) return
		if (hydratedTypesRef.current.has(typeFilter)) return
		if (!displaySettingsQuery.isSuccess) return
		// Mark hydrated even if there are no persisted settings yet — that lets
		// the write-through effect start tracking once the user makes their
		// first change, without re-running this hydrate block.
		hydratedTypesRef.current.add(typeFilter)
		const persisted = displaySettingsQuery.data
		if (!persisted || !urlIsInDefaultShape) return
		const s = persisted.settings
		const updates: Record<string, string | undefined> = {}
		if (s.sort) updates.sort = s.sort
		if (s.order) updates.order = s.order
		if (s.groupBy) updates.groupBy = s.groupBy
		if (s.filters?.status) updates.status = s.filters.status
		if (s.filters?.owner) updates.owner = s.filters.owner
		if (Object.keys(updates).length > 0) updateSearch(updates)
		if (s.columnVisibility) setColumnVisibility(s.columnVisibility)
	}, [
		typeFilter,
		displaySettingsQuery.isSuccess,
		displaySettingsQuery.data,
		urlIsInDefaultShape,
		updateSearch,
	])

	// Write-through. Only fires after this type has been hydrated so the
	// initial apply doesn't immediately re-write the same blob back.
	useEffect(() => {
		if (!typeFilter) return
		if (!hydratedTypesRef.current.has(typeFilter)) return
		const settings: DisplaySettingsBody = {
			view: 'list',
			sort,
			order,
			groupBy: groupBy ?? null,
			columnVisibility,
		}
		const filters: { status?: string; owner?: string } = {}
		if (statusFilter) filters.status = statusFilter
		if (ownerFilter) filters.owner = ownerFilter
		if (filters.status || filters.owner) settings.filters = filters

		const handle = setTimeout(() => {
			updateMutateRef.current({ objectType: typeFilter, settings })
		}, 500)
		return () => clearTimeout(handle)
	}, [typeFilter, sort, order, groupBy, statusFilter, ownerFilter, columnVisibility])

	const idsCount = idsFilter ? idsFilter.split(',').length : 0

	const clearIdsFilter = useCallback(() => {
		updateSearch({ ids: undefined })
	}, [updateSearch])

	const bulkOwnerOptions = useMemo(
		() => (actors ?? []).map((a) => ({ id: a.id, name: a.name })),
		[actors],
	)

	const bulkUpdate = useBulkUpdateObjects(workspaceId)
	const queryClient = useQueryClient()

	const reportBulkResult = useCallback(
		(
			response: { results: Array<{ id: string; ok: boolean; error?: string }> },
			total: number,
			verb: 'updated' | 'deleted',
		) => {
			const okCount = response.results.filter((r) => r.ok).length
			const failed = total - okCount
			if (failed === 0) {
				toast.success(`${okCount} object${okCount === 1 ? '' : 's'} ${verb}`)
				clearSelection()
			} else {
				const firstError = response.results.find((r) => !r.ok)?.error
				toast.error(`${okCount} of ${total} ${verb}; ${failed} failed`, {
					description: firstError,
				})
			}
		},
		[clearSelection],
	)

	const handleBulkStatusChange = useCallback(
		(status: string) => {
			if (selectedIds.length === 0) return
			const ids = [...selectedIds]
			bulkUpdate.mutate(
				{ ids, patch: { status } },
				{
					onSuccess: (data) => reportBulkResult(data, ids.length, 'updated'),
					onError: () => toast.error('Failed to update objects'),
				},
			)
		},
		[selectedIds, bulkUpdate, reportBulkResult],
	)

	const handleBulkOwnerChange = useCallback(
		(ownerId: string) => {
			if (selectedIds.length === 0) return
			const ids = [...selectedIds]
			bulkUpdate.mutate(
				{ ids, patch: { owner: ownerId } },
				{
					onSuccess: (data) => reportBulkResult(data, ids.length, 'updated'),
					onError: () => toast.error('Failed to update objects'),
				},
			)
		},
		[selectedIds, bulkUpdate, reportBulkResult],
	)

	// Build the path the app uses for object detail pages — kept relative so we can
	// resolve to an absolute URL for clipboard payloads but pass the path directly
	// to window.open for new-tab navigation.
	const objectPath = useCallback((id: string) => `/${workspaceId}/objects/${id}`, [workspaceId])

	// Selected objects we have loaded data for. Titles aren't available for rows
	// outside the current pages, so copy-title actions warn when any selected id
	// hasn't been fetched yet.
	const selectedObjectsLoaded = useMemo(() => {
		if (selectedIds.length === 0) return []
		const idSet = new Set(selectedIds)
		return allObjects.filter((o) => idSet.has(o.id))
	}, [selectedIds, allObjects])

	// Status options for the bulk action bar — scoped to the selected objects' type.
	// When the selection spans multiple types (or any selected row isn't loaded so we
	// can't verify its type), return [] so the BulkActionBar hides the status control.
	const bulkStatusOptions = useMemo(() => {
		if (selectedIds.length === 0) return []
		if (selectedObjectsLoaded.length !== selectedIds.length) return []
		const types = new Set(selectedObjectsLoaded.map((o) => o.type))
		if (types.size !== 1) return []
		const [type] = types
		const statuses = statusesByType[type as string] ?? []
		return statuses.map((s) => ({ value: s, label: s }))
	}, [selectedIds, selectedObjectsLoaded, statusesByType])

	const handleCopyLinks = useCallback(async () => {
		if (selectedIds.length === 0) return
		const text = selectedIds.map((id) => `${window.location.origin}${objectPath(id)}`).join('\n')
		try {
			await navigator.clipboard.writeText(text)
			toast.success(`Copied ${selectedIds.length} link${selectedIds.length === 1 ? '' : 's'}`)
		} catch {
			toast.error('Failed to copy to clipboard')
		}
	}, [selectedIds, objectPath])

	const handleCopyTitles = useCallback(async () => {
		if (selectedObjectsLoaded.length === 0) return
		const text = selectedObjectsLoaded.map((o) => o.title?.trim() || '(untitled)').join('\n')
		try {
			await navigator.clipboard.writeText(text)
			const n = selectedObjectsLoaded.length
			const missing = selectedIds.length - n
			toast.success(`Copied ${n} title${n === 1 ? '' : 's'}`, {
				description:
					missing > 0 ? `${missing} not loaded yet — scroll to load them first.` : undefined,
			})
		} catch {
			toast.error('Failed to copy to clipboard')
		}
	}, [selectedObjectsLoaded, selectedIds.length])

	const handleCopyTitlesAsLinks = useCallback(async () => {
		if (selectedObjectsLoaded.length === 0) return
		const text = selectedObjectsLoaded
			.map((o) => {
				const title = o.title?.trim() || '(untitled)'
				return `[${title}](${window.location.origin}${objectPath(o.id)})`
			})
			.join('\n')
		try {
			await navigator.clipboard.writeText(text)
			const n = selectedObjectsLoaded.length
			const missing = selectedIds.length - n
			toast.success(`Copied ${n} link${n === 1 ? '' : 's'} as Markdown`, {
				description:
					missing > 0 ? `${missing} not loaded yet — scroll to load them first.` : undefined,
			})
		} catch {
			toast.error('Failed to copy to clipboard')
		}
	}, [selectedObjectsLoaded, selectedIds.length, objectPath])

	const handleOpenLinks = useCallback(() => {
		for (const id of selectedIds) {
			window.open(objectPath(id), '_blank', 'noopener,noreferrer')
		}
	}, [selectedIds, objectPath])

	// No bulk-delete endpoint yet — loop through the existing single-object DELETE
	// so the UX (partial-failure toast + selection-clear on full success) matches
	// the bulk-update path. See tech-debt insight: add /api/objects/bulk-delete.
	const handleBulkDelete = useCallback(async () => {
		if (selectedIds.length === 0) return
		const ids = [...selectedIds]
		const idSet = new Set(ids)

		// Optimistically drop the rows from list caches so the table updates
		// immediately. The invalidate at the end reconciles with the server, so any
		// row whose DELETE failed will reappear on the refetch.
		const listEntries = queryClient.getQueriesData<ObjectResponse[]>({
			queryKey: queryKeys.objects.listPrefix(workspaceId),
		})
		for (const [key, cache] of listEntries) {
			if (!cache) continue
			queryClient.setQueryData<ObjectResponse[]>(
				key,
				cache.filter((o) => !idSet.has(o.id)),
			)
		}
		const infiniteEntries = queryClient.getQueriesData<InfiniteData<ObjectResponse[]>>({
			queryKey: queryKeys.objects.listInfinitePrefix(workspaceId),
		})
		for (const [key, cache] of infiniteEntries) {
			if (!cache) continue
			queryClient.setQueryData<InfiniteData<ObjectResponse[]>>(key, {
				...cache,
				pages: cache.pages.map((page) => page.filter((o) => !idSet.has(o.id))),
			})
		}
		for (const id of ids) {
			queryClient.removeQueries({ queryKey: queryKeys.objects.detail(id) })
		}

		const settled = await Promise.allSettled(ids.map((id) => api.objects.delete(id)))
		const results = settled.map((r, i) => ({
			id: ids[i] as string,
			ok: r.status === 'fulfilled' && r.value.deleted,
			error: r.status === 'rejected' ? String(r.reason) : undefined,
		}))
		queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
		queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })

		// Keep selection only for ids whose DELETE failed, so the bar stays pinned
		// to the rows that still need attention. reportBulkResult clears selection
		// on full success; on partial failure we want the failed ids to remain
		// selected (and the deleted ones removed so their stale ids don't linger).
		const failedIds = new Set(results.filter((r) => !r.ok).map((r) => r.id))
		setRowSelection((prev) => {
			const next: RowSelectionState = {}
			for (const id of Object.keys(prev)) {
				if (failedIds.has(id) || !idSet.has(id)) next[id] = prev[id] as boolean
			}
			return next
		})

		reportBulkResult({ results }, ids.length, 'deleted')
	}, [selectedIds, queryClient, workspaceId, reportBulkResult])

	return (
		<div className="flex flex-col flex-1 min-h-0">
			<PageHeader title="Objects" />

			{idsFilter && (
				<div className="flex items-center gap-2 mx-6 mb-3 px-3 py-2 rounded-md bg-muted/50 border text-sm">
					<Filter className="h-4 w-4 text-muted-foreground shrink-0" />
					<span className="text-muted-foreground">
						Showing{' '}
						<Badge variant="secondary" className="mx-0.5">
							{idsCount}
						</Badge>{' '}
						{idsCount === 1 ? 'object' : 'objects'} from notification
					</span>
					<Button
						variant="ghost"
						size="sm"
						className="ml-auto h-6 px-2 text-muted-foreground hover:text-foreground"
						onClick={clearIdsFilter}
					>
						<X className="h-3 w-3 mr-1" />
						Clear filter
					</Button>
				</div>
			)}

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
			<BulkActionBar
				selectedCount={selectedIds.length}
				statusOptions={bulkStatusOptions}
				ownerOptions={bulkOwnerOptions}
				onStatusChange={handleBulkStatusChange}
				onOwnerChange={handleBulkOwnerChange}
				onCopyLink={handleCopyLinks}
				onCopyTitle={handleCopyTitles}
				onCopyTitleAsLink={handleCopyTitlesAsLinks}
				onOpenLinks={handleOpenLinks}
				onDelete={handleBulkDelete}
				onClear={clearSelection}
			/>
		</div>
	)
}
