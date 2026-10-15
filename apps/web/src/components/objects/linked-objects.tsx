import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useFiles } from '@/hooks/use-files'
import { useObjects } from '@/hooks/use-objects'
import {
	useCreateRelationship,
	useDeleteRelationship,
	useRelationships,
} from '@/hooks/use-relationships'
import type {
	CreateRelationshipInput,
	GraphFileSummary,
	ObjectResponse,
	RelationshipResponse,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StatusBadge } from '../shared/status-badge'
import { TypeBadge } from '../shared/type-badge'
import { DataTableControls } from './data-table/data-table-controls'
import { MimeTile, formatBytes } from './file-tile'
import { RelatedObjectsTable, type ResolvedRow } from './related-objects-table'

function resolveLinkedObjectId(rel: RelationshipResponse, currentId: string): string {
	return rel.sourceId === currentId ? rel.targetId : rel.sourceId
}

const DEFAULT_FILE_RELATIONSHIP_TYPE = 'attached'

export function LinkedObjectsView({
	objectId,
	objectType,
	asSource,
	asTarget,
	workspaceId,
	allObjects,
	connectedObjects,
	files,
	relationshipTypes,
	onCreateRelationship,
	onDeleteRelationship,
	onNavigate,
	isLoading,
	isError,
	errorStatus,
	onRetry,
	heading,
	showTabCounts,
	menuLabels,
	openPickerSignal,
}: {
	objectId: string
	objectType: string
	asSource: RelationshipResponse[]
	asTarget: RelationshipResponse[]
	workspaceId: string
	allObjects: ObjectResponse[]
	connectedObjects?: ObjectResponse[]
	/** Files hydrated by the graph endpoint — the source of truth for the
	 *  `fileMap` that resolves file endpoints. Slice 1 makes files first-class
	 *  Related-tab endpoints; without this array a file endpoint reads as
	 *  unresolvable and drops from the list. */
	files?: GraphFileSummary[]
	relationshipTypes: string[]
	onCreateRelationship: (data: CreateRelationshipInput, context?: { targetTitle?: string }) => void
	onDeleteRelationship: (id: string) => void
	onNavigate?: (workspaceId: string, objectId: string) => void
	/** Loading state for the graph fetch — renders the skeleton band from
	 *  Designer spec §4 while `true`. */
	isLoading?: boolean
	/** Error state for the graph fetch — renders the inline red card. */
	isError?: boolean
	/** HTTP status the fetch failed with, for the mono line in the error card. */
	errorStatus?: number | string
	/** Retry handler for the inline error card. */
	onRetry?: () => void
	/** Section heading label. Defaults to `Related` (object-detail); the
	 *  file-detail page passes `Linked` per design spec §6 copy table. */
	heading?: string
	/** When true, render inline `Objects (n) / Files (n)` count pills next to
	 *  the heading. File-detail turns this on so the Linked section surfaces
	 *  per-tab counts without depending on filter-chip opening; Related tab
	 *  keeps its existing `DataTableControls` filter behaviour. */
	showTabCounts?: boolean
	/** Optional override for the `+` menu labels. File-detail flips the
	 *  primary CTA to `Link to object` (defaulting the picker to Objects); the
	 *  secondary label is omitted when null — file→file linking is an agent
	 *  affordance, not a UI one. */
	menuLabels?: {
		primary: { label: string; kind: 'object' | 'file' }
		secondary?: { label: string; kind: 'object' | 'file' } | null
	}
	/**
	 * Parent-driven trigger to open the picker from outside the header `+`
	 * menu. The value is a `{ kind, nonce }` tuple; every time `nonce` changes
	 * the view opens the picker with `kind` pre-selected. Used by the
	 * file-detail page's `Link to object` button.
	 */
	openPickerSignal?: { kind: 'object' | 'file'; nonce: number } | null
}) {
	const [activeFilter, setActiveFilter] = useState<string>('all')
	const [addLinkKind, setAddLinkKind] = useState<'object' | 'file' | null>(null)

	// External open trigger (file-detail's `Link to object` button). Watching
	// the nonce (not the kind) so the same-kind click retriggers.
	const signalNonce = openPickerSignal?.nonce
	useEffect(() => {
		if (openPickerSignal && signalNonce !== undefined) {
			setAddLinkKind(openPickerSignal.kind)
		}
	}, [openPickerSignal, signalNonce])

	// Build map from both sources so linked objects always resolve, even when
	// they fall outside the paginated workspace listing in `allObjects`.
	const objectMap = useMemo(() => {
		const map = new Map<string, ObjectResponse>()
		for (const o of allObjects) map.set(o.id, o)
		if (connectedObjects) for (const o of connectedObjects) map.set(o.id, o)
		return map
	}, [allObjects, connectedObjects])

	// Files as first-class endpoints: `fileMap` sits alongside `objectMap` and
	// the resolver checks both. A file endpoint reads out as a `FileRow`; an
	// object endpoint reads out as the existing object row.
	const fileMap = useMemo(() => {
		const map = new Map<string, GraphFileSummary>()
		if (files) for (const f of files) map.set(f.id, f)
		return map
	}, [files])

	// Merge all relationships into a flat list with resolved endpoints
	const allRelationships = useMemo(() => {
		const allRels = [...asSource, ...asTarget]
		const seen = new Set<string>()
		const resolved: ResolvedRow[] = []

		for (const rel of allRels) {
			if (seen.has(rel.id)) continue
			seen.add(rel.id)

			const linkedId = resolveLinkedObjectId(rel, objectId)
			const obj = objectMap.get(linkedId)
			if (obj) {
				resolved.push({ kind: 'object', rel, object: obj })
				continue
			}
			const file = fileMap.get(linkedId)
			if (file) resolved.push({ kind: 'file', rel, file })
		}

		return resolved
	}, [asSource, asTarget, objectId, objectMap, fileMap])

	// Type-count buckets for filter chips. Files bucket under a synthetic
	// `file` type so the DataTableControls chip strip surfaces a `File` chip
	// whenever any file endpoint is present.
	const typeCounts = useMemo(() => {
		const counts: Record<string, number> = {}
		for (const row of allRelationships) {
			const type = row.kind === 'file' ? 'file' : row.object.type
			counts[type] = (counts[type] ?? 0) + 1
		}
		return counts
	}, [allRelationships])

	const uniqueTypes = Object.keys(typeCounts)

	// Fall back to 'all' when the selected type no longer has any relationships
	const effectiveFilter = activeFilter !== 'all' && !typeCounts[activeFilter] ? 'all' : activeFilter

	// Filter by active type
	const filteredRelationships =
		effectiveFilter === 'all'
			? allRelationships
			: allRelationships.filter((r) => {
					const rowType = r.kind === 'file' ? 'file' : r.object.type
					return rowType === effectiveFilter
				})

	const totalCount = allRelationships.length
	const existingRelationships = [...asSource, ...asTarget]

	const openLinkTo = (kind: 'object' | 'file') => setAddLinkKind(kind)

	return (
		<div>
			{/* Header */}
			<div className="flex items-center gap-2 mb-2">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					{heading ?? 'Related'} ({totalCount})
				</h3>
				{showTabCounts && (
					<div
						className="flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-wider text-muted-foreground"
						aria-label="Type counts"
					>
						<span>
							Objects ({typeCounts.file ? totalCount - (typeCounts.file ?? 0) : totalCount})
						</span>
						<span aria-hidden="true">·</span>
						<span>Files ({typeCounts.file ?? 0})</span>
					</div>
				)}
				<div className="flex-1" />
				{uniqueTypes.length >= 2 && (
					<DataTableControls
						iconOnly
						typeFilter={effectiveFilter === 'all' ? undefined : effectiveFilter}
						onTypeFilterChange={(value) => setActiveFilter(value ?? 'all')}
						typeCounts={typeCounts}
					/>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="h-8 w-8"
							title="Add link"
							aria-label="Add link"
						>
							<Plus size={14} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-[180px]">
						{/* Keyboard hints "O" / "F" match Designer §7 — the picker
						  itself also intercepts O/F to jump between tabs. On
						  file-detail the primary CTA is `Link to object`, so the
						  menu's leading item flips accordingly. */}
						<DropdownMenuItem onSelect={() => openLinkTo(menuLabels?.primary.kind ?? 'object')}>
							<span className="flex-1">{menuLabels?.primary.label ?? 'Link to object'}</span>
							<span className="ml-3 font-mono text-[10px] text-muted-foreground">
								{(menuLabels?.primary.kind ?? 'object') === 'object' ? 'O' : 'F'}
							</span>
						</DropdownMenuItem>
						{menuLabels?.secondary !== null && (
							<DropdownMenuItem onSelect={() => openLinkTo(menuLabels?.secondary?.kind ?? 'file')}>
								<span className="flex-1">{menuLabels?.secondary?.label ?? 'Link to file'}</span>
								<span className="ml-3 font-mono text-[10px] text-muted-foreground">
									{(menuLabels?.secondary?.kind ?? 'file') === 'file' ? 'F' : 'O'}
								</span>
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{/* Add link form */}
			{addLinkKind && (
				<AddLinkForm
					objectId={objectId}
					objectType={objectType}
					allObjects={allObjects}
					relationshipTypes={relationshipTypes}
					existingRelationships={existingRelationships}
					defaultKind={addLinkKind}
					onCreateRelationship={onCreateRelationship}
					onClose={() => setAddLinkKind(null)}
				/>
			)}

			{/* Body — loading / error / empty / default */}
			{isLoading ? (
				<RelatedLoadingSkeleton />
			) : isError ? (
				<RelatedErrorCard objectId={objectId} status={errorStatus} onRetry={onRetry} />
			) : filteredRelationships.length > 0 ? (
				<RelatedObjectsTable
					rows={filteredRelationships}
					workspaceId={workspaceId}
					onDeleteRelationship={onDeleteRelationship}
					onNavigate={onNavigate}
				/>
			) : (
				<RelatedEmptyState
					onLinkObject={() => openLinkTo('object')}
					onLinkFile={() => openLinkTo('file')}
				/>
			)}
		</div>
	)
}

export function LinkedObjects({
	objectId,
	objectType,
	asSource,
	asTarget,
	connectedObjects,
	files,
}: {
	objectId: string
	objectType: string
	asSource: RelationshipResponse[]
	asTarget: RelationshipResponse[]
	connectedObjects?: ObjectResponse[]
	files?: GraphFileSummary[]
}) {
	const { workspaceId, workspace } = useWorkspace()
	const { data: allObjects } = useObjects(workspaceId)
	const createRelationship = useCreateRelationship(workspaceId, objectId)
	const deleteRelationship = useDeleteRelationship(workspaceId, objectId)

	const settings = workspace.settings as Record<string, unknown>
	const relationshipTypes = (settings?.relationship_types as string[] | undefined) ?? [
		'informs',
		'breaks_into',
		'blocks',
		'relates_to',
		'duplicates',
	]

	return (
		<LinkedObjectsView
			objectId={objectId}
			objectType={objectType}
			asSource={asSource}
			asTarget={asTarget}
			workspaceId={workspaceId}
			allObjects={allObjects ?? []}
			connectedObjects={connectedObjects}
			files={files}
			relationshipTypes={relationshipTypes}
			onCreateRelationship={(data, ctx) =>
				createRelationship.mutate({ ...data, linkedTitle: ctx?.targetTitle })
			}
			onDeleteRelationship={(id) => deleteRelationship.mutate(id)}
		/>
	)
}

/**
 * File-detail wrapper. Same `LinkedObjectsView` component the object-detail
 * Related tab renders, entered with `objectId=file.id` and `objectType='file'`
 * per design spec §10. No object-graph endpoint exists for a file id, so this
 * composes the same shape from the workspace-scoped relationships list —
 * split into `asSource` / `asTarget`, with connected objects and reciprocal
 * files hydrated by their existing list hooks.
 */
export function LinkedObjectsForFile({
	fileId,
	openPickerSignal,
}: {
	fileId: string
	/**
	 * `{ kind, nonce }` — bumping `nonce` opens the picker with `kind`
	 * pre-selected. Used by the file-detail header's `Link to object` button
	 * to trigger the picker (Objects tab default, per design spec §3.1 step 6).
	 */
	openPickerSignal?: { kind: 'object' | 'file'; nonce: number } | null
}) {
	const { workspaceId, workspace } = useWorkspace()
	const relQuery = useRelationships(workspaceId, { object_id: fileId })
	const { data: allObjects } = useObjects(workspaceId)
	const { data: allFiles } = useFiles(workspaceId)
	const createRelationship = useCreateRelationship(workspaceId, fileId)
	const deleteRelationship = useDeleteRelationship(workspaceId, fileId)

	const settings = workspace.settings as Record<string, unknown>
	const relationshipTypes = (settings?.relationship_types as string[] | undefined) ?? [
		'informs',
		'breaks_into',
		'blocks',
		'relates_to',
		'duplicates',
	]

	const asSource = useMemo(
		() => (relQuery.data ?? []).filter((r) => r.sourceId === fileId),
		[relQuery.data, fileId],
	)
	const asTarget = useMemo(
		() => (relQuery.data ?? []).filter((r) => r.targetId === fileId),
		[relQuery.data, fileId],
	)

	// Reciprocal endpoint ids — anything on the other side of an edge.
	const otherEndpointIds = useMemo(() => {
		const ids = new Set<string>()
		for (const r of relQuery.data ?? []) {
			if (r.sourceId !== fileId) ids.add(r.sourceId)
			if (r.targetId !== fileId) ids.add(r.targetId)
		}
		return ids
	}, [relQuery.data, fileId])

	const connectedObjects = useMemo(
		() => (allObjects ?? []).filter((o) => otherEndpointIds.has(o.id)),
		[allObjects, otherEndpointIds],
	)

	// Adapt `FileListItem` to `GraphFileSummary` (drops storageKey/description,
	// adds a client-minted viewer `url` so file rows navigate correctly from
	// the Linked table). We only surface reciprocal files here — the file
	// itself is the anchor, not a row in its own list.
	const files = useMemo<GraphFileSummary[]>(
		() =>
			(allFiles ?? [])
				.filter((f) => otherEndpointIds.has(f.id))
				.map((f) => ({
					id: f.id,
					name: f.name,
					mimeType: f.mimeType,
					sizeBytes: f.sizeBytes,
					url:
						typeof window !== 'undefined'
							? `${window.location.origin}/${workspaceId}/files/${f.id}`
							: `/${workspaceId}/files/${f.id}`,
				})),
		[allFiles, otherEndpointIds, workspaceId],
	)

	return (
		<LinkedObjectsView
			objectId={fileId}
			objectType="file"
			asSource={asSource}
			asTarget={asTarget}
			workspaceId={workspaceId}
			allObjects={allObjects ?? []}
			connectedObjects={connectedObjects}
			files={files}
			relationshipTypes={relationshipTypes}
			onCreateRelationship={(data, ctx) =>
				createRelationship.mutate({ ...data, linkedTitle: ctx?.targetTitle })
			}
			onDeleteRelationship={(id) => deleteRelationship.mutate(id)}
			isLoading={relQuery.isLoading}
			isError={relQuery.isError}
			errorStatus={relQuery.error instanceof Error ? relQuery.error.message : undefined}
			onRetry={() => relQuery.refetch()}
			heading="Linked"
			showTabCounts
			// File-detail's primary link CTA is `Link to object`, defaulting the
			// picker to the Objects tab — inverse of object-detail's `Link to
			// file` primary (design spec §3.1 step 6, §4 File detail — Actions
			// row). File→file linking stays available via the MCP tool, so the
			// UI keeps a single CTA.
			menuLabels={{
				primary: { label: 'Link to object', kind: 'object' },
				secondary: null,
			}}
			openPickerSignal={openPickerSignal}
		/>
	)
}

function RelatedLoadingSkeleton() {
	// 5 shimmer rows keeping the same 32px height a real row takes; matches
	// Designer spec §4 (4–6 rows, `--muted` → `--secondary` gradient). Reuses
	// the animate-pulse token stack already in the app.
	return (
		<ul aria-label="Loading related items" className="m-0 list-none p-0">
			{Array.from({ length: 5 }).map((_, i) => (
				<li
					// biome-ignore lint/suspicious/noArrayIndexKey: skeleton row list is fixed length + order
					key={i}
					className="flex h-8 items-center gap-2 border-b border-border/60 px-2"
				>
					<div className="h-3 w-3 shrink-0 rounded-sm bg-gradient-to-r from-muted to-secondary animate-pulse" />
					<div className="h-3 flex-1 max-w-[220px] rounded bg-gradient-to-r from-muted to-secondary animate-pulse" />
					<div className="h-3 w-16 rounded bg-gradient-to-r from-muted to-secondary animate-pulse" />
				</li>
			))}
		</ul>
	)
}

function RelatedErrorCard({
	objectId,
	status,
	onRetry,
}: {
	objectId: string
	status?: number | string
	onRetry?: () => void
}) {
	return (
		<div
			role="alert"
			className="rounded-lg border p-3 text-sm"
			style={{ backgroundColor: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c' }}
		>
			<div className="font-medium">Couldn't load related items.</div>
			<div className="mt-1 font-mono text-[10.5px] opacity-90">
				GET /api/objects/{objectId}/graph failed · {status ?? 'error'}
			</div>
			{onRetry && (
				<Button
					variant="outline"
					size="sm"
					className="mt-2 h-7 text-[12px]"
					style={{ color: '#b91c1c', borderColor: '#fecaca' }}
					onClick={onRetry}
				>
					Retry
				</Button>
			)}
		</div>
	)
}

function RelatedEmptyState({
	onLinkObject,
	onLinkFile,
}: {
	onLinkObject: () => void
	onLinkFile: () => void
}) {
	return (
		<div className="rounded-xl border border-dashed border-border bg-muted/40 px-4 py-6 text-center">
			<div className="text-sm font-medium text-foreground">No links yet</div>
			<p className="mt-1 text-xs text-muted-foreground">
				Attach a file, link to another object, or drag a file here.
			</p>
			<div className="mt-3 flex flex-wrap items-center justify-center gap-2">
				<Button variant="outline" size="sm" onClick={onLinkObject}>
					Link to object
				</Button>
				<Button variant="outline" size="sm" onClick={onLinkFile}>
					Link to file
				</Button>
			</div>
		</div>
	)
}

// ── AddLinkForm — Objects | Files tab strip ─────────────────────────────

type PickerTab = 'objects' | 'files'

export function AddLinkForm({
	objectId,
	objectType,
	allObjects,
	relationshipTypes,
	existingRelationships,
	defaultRelationshipType,
	defaultKind,
	onCreateRelationship,
	onClose,
}: {
	objectId: string
	objectType: string
	allObjects: ObjectResponse[]
	relationshipTypes: string[]
	existingRelationships: RelationshipResponse[]
	/** Pre-select this type — the group the CTA row belongs to. */
	defaultRelationshipType?: string
	/** Which picker tab opens by default. Files → default relation-type
	 *  becomes `attached` per Designer spec §4. */
	defaultKind?: PickerTab | 'object' | 'file'
	onCreateRelationship: (data: CreateRelationshipInput, context?: { targetTitle?: string }) => void
	onClose: () => void
}) {
	const initialTab: PickerTab =
		defaultKind === 'file' || defaultKind === 'files' ? 'files' : 'objects'
	const [tab, setTab] = useState<PickerTab>(initialTab)
	const [relType, setRelType] = useState(() => {
		if (initialTab === 'files') return DEFAULT_FILE_RELATIONSHIP_TYPE
		return defaultRelationshipType ?? relationshipTypes[0] ?? 'relates_to'
	})

	// Reset the default relation-type whenever the tab flips — Files always
	// defaults to `attached` (the file-attach semantic), Objects goes back to
	// the CTA-scoped default or the first configured type.
	useEffect(() => {
		if (tab === 'files') setRelType(DEFAULT_FILE_RELATIONSHIP_TYPE)
		else setRelType(defaultRelationshipType ?? relationshipTypes[0] ?? 'relates_to')
	}, [tab, defaultRelationshipType, relationshipTypes])

	const { workspaceId } = useWorkspace()
	const { data: allFiles } = useFiles(workspaceId)

	const [search, setSearch] = useState('')
	const [activeIndex, setActiveIndex] = useState(0)
	// Debounced result-count announcement so screen readers hear "N results"
	// once per pause, not once per keystroke.
	const [announcement, setAnnouncement] = useState('')
	const searchInputRef = useRef<HTMLInputElement | null>(null)

	const existingIds = useMemo(
		() => new Set(existingRelationships.flatMap((r) => [r.sourceId, r.targetId])),
		[existingRelationships],
	)

	const objectCandidates = useMemo(
		() =>
			allObjects
				.filter((o) => o.id !== objectId && !existingIds.has(o.id))
				.filter(
					(o) =>
						!search ||
						o.title?.toLowerCase().includes(search.toLowerCase()) ||
						o.type.includes(search.toLowerCase()),
				)
				.slice(0, 10),
		[allObjects, objectId, search, existingIds],
	)

	const fileCandidates = useMemo(
		() =>
			(allFiles ?? [])
				.filter((f) => !existingIds.has(f.id))
				.filter((f) => !search || f.name.toLowerCase().includes(search.toLowerCase()))
				.slice(0, 10),
		[allFiles, search, existingIds],
	)

	const rows = tab === 'objects' ? objectCandidates : fileCandidates
	const rowsCount = rows.length

	// Reset the highlighted index when the row set changes (tab switch or
	// search input) so keyboard nav starts at the top.
	// biome-ignore lint/correctness/useExhaustiveDependencies: bounded to rowsCount + tab
	useEffect(() => {
		setActiveIndex(0)
	}, [tab, rowsCount])

	// Debounced announcement: 220ms after the last row-count change (a search
	// re-filter or tab switch), publish "N result(s)" into the polite live
	// region so screen readers hear one summary per pause, not per keystroke.
	useEffect(() => {
		const label = `${rowsCount} result${rowsCount === 1 ? '' : 's'}`
		const t = setTimeout(() => setAnnouncement(label), 220)
		return () => clearTimeout(t)
	}, [rowsCount])

	const handleLinkObject = useCallback(
		(target: ObjectResponse) => {
			onCreateRelationship(
				{
					source_type: objectType,
					source_id: objectId,
					target_type: target.type ?? objectType,
					target_id: target.id,
					type: relType,
				},
				{ targetTitle: target.title ?? 'Untitled' },
			)
			onClose()
			setSearch('')
		},
		[objectType, objectId, relType, onCreateRelationship, onClose],
	)

	const handleLinkFile = useCallback(
		(target: { id: string; name: string }) => {
			onCreateRelationship(
				{
					source_type: objectType,
					source_id: objectId,
					// Server derives kind from the endpoint id via
					// `deriveEndpointKinds`; the caller-supplied label is documentary.
					target_type: 'file',
					target_id: target.id,
					type: relType,
				},
				{ targetTitle: target.name },
			)
			onClose()
			setSearch('')
		},
		[objectType, objectId, relType, onCreateRelationship, onClose],
	)

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		// Tab-jump shortcuts. Guard with Meta/Alt so 'o' or 'f' typed into the
		// search input still work as text; the shortcuts fire only when the
		// modifier is held.
		if ((e.metaKey || e.altKey) && (e.key === 'o' || e.key === 'O')) {
			e.preventDefault()
			setTab('objects')
			return
		}
		if ((e.metaKey || e.altKey) && (e.key === 'f' || e.key === 'F')) {
			e.preventDefault()
			setTab('files')
			return
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			setActiveIndex((i) => Math.min(rowsCount - 1, i + 1))
			return
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault()
			setActiveIndex((i) => Math.max(0, i - 1))
			return
		}
		if (e.key === 'Enter') {
			e.preventDefault()
			if (tab === 'objects' && objectCandidates[activeIndex]) {
				handleLinkObject(objectCandidates[activeIndex])
			} else if (tab === 'files' && fileCandidates[activeIndex]) {
				handleLinkFile(fileCandidates[activeIndex])
			}
			return
		}
		if (e.key === 'Escape') {
			e.preventDefault()
			onClose()
		}
	}

	const listboxId = `addlink-listbox-${tab}`

	return (
		<div className="rounded border border-border bg-card p-3 space-y-2 mb-3">
			{/* Tab strip — Objects | Files. The active tab pill uses the same
			   duration-150 transition as the rest of the v2 shell. */}
			<div className="flex items-center gap-2">
				<TabPill
					active={tab === 'objects'}
					onClick={() => setTab('objects')}
					shortcut="O"
					label="Objects"
				/>
				<TabPill
					active={tab === 'files'}
					onClick={() => setTab('files')}
					shortcut="F"
					label="Files"
				/>
				<div className="flex-1" />
				<Label htmlFor="rel-type-select" className="text-xs">
					Type:
				</Label>
				<Select value={relType} onValueChange={setRelType}>
					<SelectTrigger id="rel-type-select">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{[
							DEFAULT_FILE_RELATIONSHIP_TYPE,
							...relationshipTypes.filter((t) => t !== DEFAULT_FILE_RELATIONSHIP_TYPE),
						].map((t) => (
							<SelectItem key={t} value={t}>
								{t.replace(/_/g, ' ')}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<input
				ref={searchInputRef}
				type="text"
				value={search}
				onChange={(e) => setSearch(e.target.value)}
				onKeyDown={onKeyDown}
				placeholder={tab === 'files' ? 'Search files by name…' : 'Search objects…'}
				aria-label={tab === 'files' ? 'Search files' : 'Search objects'}
				aria-controls={listboxId}
				aria-activedescendant={rows.length > 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
				className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:border-ring outline-none"
			/>

			{/* Polite live region — announces N results after debounce. */}
			<output className="sr-only" aria-live="polite">
				{announcement}
			</output>

			<div
				id={listboxId}
				// biome-ignore lint/a11y/useSemanticElements: focus lives on the search input via aria-activedescendant; a native <select> can't hold rich content
				role="listbox"
				tabIndex={-1}
				aria-label={tab === 'files' ? 'Files' : 'Objects'}
				className="max-h-32 overflow-auto space-y-0.5"
			>
				{tab === 'objects' &&
					objectCandidates.map((obj, i) => (
						<button
							key={obj.id}
							type="button"
							id={`${listboxId}-opt-${i}`}
							// biome-ignore lint/a11y/useSemanticElements: rendered inside a listbox
							role="option"
							aria-selected={i === activeIndex}
							onMouseEnter={() => setActiveIndex(i)}
							onClick={() => handleLinkObject(obj)}
							className={cn(
								'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors',
								i === activeIndex ? 'bg-muted' : 'hover:bg-muted/60',
							)}
						>
							<span className="flex-1 truncate">{obj.title || 'Untitled'}</span>
							<TypeBadge type={obj.type} />
							<StatusBadge status={obj.status} />
						</button>
					))}
				{tab === 'files' &&
					fileCandidates.map((file, i) => (
						<button
							key={file.id}
							type="button"
							id={`${listboxId}-opt-${i}`}
							// biome-ignore lint/a11y/useSemanticElements: rendered inside a listbox
							role="option"
							aria-selected={i === activeIndex}
							onMouseEnter={() => setActiveIndex(i)}
							onClick={() => handleLinkFile(file)}
							className={cn(
								'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors',
								i === activeIndex ? 'bg-muted' : 'hover:bg-muted/60',
							)}
						>
							<MimeTile mimeType={file.mimeType} size="sm" />
							<span className="flex-1 truncate">{file.name}</span>
							<span className="font-mono text-[10.5px] text-muted-foreground">
								{formatBytes(file.sizeBytes)}
							</span>
						</button>
					))}
				{rows.length === 0 && (
					<p className="text-xs text-muted-foreground py-1 px-2">
						{tab === 'files' ? 'No files match' : 'No objects found'}
					</p>
				)}
			</div>
			<Button variant="ghost" size="sm" onClick={onClose}>
				Cancel
			</Button>
		</div>
	)
}

function TabPill({
	active,
	label,
	shortcut,
	onClick,
}: {
	active: boolean
	label: string
	shortcut: string
	onClick: () => void
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={cn(
				'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors duration-150',
				active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
			)}
		>
			<span>{label}</span>
			<span
				className={cn(
					'font-mono text-[9.5px]',
					active ? 'text-muted-foreground' : 'text-border-strong',
				)}
			>
				{shortcut}
			</span>
		</button>
	)
}
