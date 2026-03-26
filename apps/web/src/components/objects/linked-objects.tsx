import { Button } from '@/components/ui/button'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useObjects } from '@/hooks/use-objects'
import { useCreateRelationship, useDeleteRelationship } from '@/hooks/use-relationships'
import type { CreateRelationshipInput, ObjectResponse, RelationshipResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { StatusBadge } from '../shared/status-badge'
import { TypeBadge } from '../shared/type-badge'

interface LinkedSection {
	title: string
	relationships: RelationshipResponse[]
	direction: 'source' | 'target'
	/** Relationship type to use when adding a new link in this section */
	addRelType?: string
	/** When adding, is the current object the source or target? */
	addDirection?: 'source' | 'target'
}

export function LinkedObjectsView({
	objectId,
	objectType,
	asSource,
	asTarget,
	workspaceId,
	allObjects,
	relationshipTypes,
	onCreateRelationship,
	onDeleteRelationship,
	onNavigate,
}: {
	objectId: string
	objectType: string
	asSource: RelationshipResponse[]
	asTarget: RelationshipResponse[]
	workspaceId: string
	allObjects: ObjectResponse[]
	relationshipTypes: string[]
	onCreateRelationship: (data: CreateRelationshipInput) => void
	onDeleteRelationship: (id: string) => void
	onNavigate?: (workspaceId: string, objectId: string) => void
}) {
	const objectMap = useMemo(() => new Map(allObjects.map((o) => [o.id, o])), [allObjects])

	const sections: LinkedSection[] = [
		{
			title: 'Linked Insights',
			relationships: asTarget.filter((r) => r.type === 'informs'),
			direction: 'source',
			addRelType: 'informs',
			addDirection: 'target',
		},
		{
			title: 'Tasks',
			relationships: asSource.filter((r) => r.type === 'breaks_into'),
			direction: 'target',
			addRelType: 'breaks_into',
			addDirection: 'source',
		},
		{
			title: 'Related',
			relationships: [
				...asSource.filter((r) => !['breaks_into'].includes(r.type)),
				...asTarget.filter((r) => !['informs'].includes(r.type)),
			],
			direction: 'target',
		},
	]

	return (
		<div className="space-y-4">
			{sections.map((section) => (
				<LinkedSectionView
					key={section.title}
					section={section}
					objectMap={objectMap}
					objectId={objectId}
					objectType={objectType}
					workspaceId={workspaceId}
					allObjects={allObjects}
					relationshipTypes={relationshipTypes}
					onCreateRelationship={onCreateRelationship}
					onDeleteRelationship={onDeleteRelationship}
					onNavigate={onNavigate}
				/>
			))}

			{/* Generic "Add link" for arbitrary relationship types */}
			<AddLinkForm
				objectId={objectId}
				objectType={objectType}
				allObjects={allObjects}
				relationshipTypes={relationshipTypes}
				existingRelationships={[...asSource, ...asTarget]}
				onCreateRelationship={onCreateRelationship}
			/>
		</div>
	)
}

export function LinkedObjects({
	objectId,
	objectType,
	asSource,
	asTarget,
}: {
	objectId: string
	objectType: string
	asSource: RelationshipResponse[]
	asTarget: RelationshipResponse[]
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
			relationshipTypes={relationshipTypes}
			onCreateRelationship={(data) => createRelationship.mutate(data)}
			onDeleteRelationship={(id) => deleteRelationship.mutate(id)}
		/>
	)
}

function LinkedSectionView({
	section,
	objectMap,
	objectId,
	objectType,
	workspaceId,
	allObjects,
	relationshipTypes,
	onCreateRelationship,
	onDeleteRelationship,
	onNavigate,
}: {
	section: LinkedSection
	objectMap: Map<string, ObjectResponse>
	objectId: string
	objectType: string
	workspaceId: string
	allObjects: ObjectResponse[]
	relationshipTypes: string[]
	onCreateRelationship: (data: CreateRelationshipInput) => void
	onDeleteRelationship: (id: string) => void
	onNavigate?: (workspaceId: string, objectId: string) => void
}) {
	const [collapsed, setCollapsed] = useState(false)
	const [showAdd, setShowAdd] = useState(false)

	const handleAdd = (targetObjectId: string) => {
		if (!section.addRelType || !section.addDirection) return
		const isSource = section.addDirection === 'source'
		const targetObj = objectMap.get(targetObjectId)
		onCreateRelationship({
			source_type: isSource ? objectType : (targetObj?.type ?? objectType),
			source_id: isSource ? objectId : targetObjectId,
			target_type: isSource ? (targetObj?.type ?? objectType) : objectType,
			target_id: isSource ? targetObjectId : objectId,
			type: section.addRelType,
		})
		setShowAdd(false)
	}

	// Objects already linked in this section
	const linkedIds = new Set(
		section.relationships.map((r) => {
			const id = section.direction === 'source' ? r.sourceId : r.targetId
			return id === objectId ? (section.direction === 'source' ? r.targetId : r.sourceId) : id
		}),
	)

	return (
		<div>
			<div className="flex items-center gap-2 mb-2">
				<button
					type="button"
					className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-muted-foreground"
					onClick={() => setCollapsed(!collapsed)}
				>
					<span>{collapsed ? '▸' : '▾'}</span>
					{section.title}
					<span className="text-muted-foreground">({section.relationships.length})</span>
				</button>
				{section.addRelType && (
					<Button variant="ghost" size="sm" onClick={() => setShowAdd(!showAdd)}>
						+ link
					</Button>
				)}
			</div>

			{showAdd && (
				<ObjectPicker
					allObjects={allObjects}
					excludeIds={new Set([objectId, ...linkedIds])}
					onSelect={handleAdd}
					onCancel={() => setShowAdd(false)}
				/>
			)}

			{!collapsed && section.relationships.length > 0 && (
				<div className="space-y-1 pl-4">
					{section.relationships.map((rel) => {
						const linkedId = section.direction === 'source' ? rel.sourceId : rel.targetId
						const resolvedId =
							linkedId === objectId
								? section.direction === 'source'
									? rel.targetId
									: rel.sourceId
								: linkedId
						const obj = objectMap.get(resolvedId)
						if (!obj) return null
						return (
							<div key={rel.id} className="flex items-center gap-2 group">
								{onNavigate ? (
									<button
										type="button"
										onClick={() => onNavigate(workspaceId, resolvedId)}
										className="flex items-center gap-2 flex-1 rounded px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 text-left"
									>
										<span className="flex-1 truncate">{obj.title || 'Untitled'}</span>
										<span className="text-xs text-muted-foreground/50 shrink-0">
											{rel.type.replace(/_/g, ' ')}
										</span>
										<StatusBadge status={obj.status} />
									</button>
								) : (
									<Link
										to="/$workspaceId/objects/$objectId"
										params={{ workspaceId, objectId: resolvedId }}
										className="flex items-center gap-2 flex-1 rounded px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50"
									>
										<span className="flex-1 truncate">{obj.title || 'Untitled'}</span>
										<span className="text-xs text-muted-foreground/50 shrink-0">
											{rel.type.replace(/_/g, ' ')}
										</span>
										<StatusBadge status={obj.status} />
									</Link>
								)}
								<Button
									variant="ghost"
									size="icon"
									className="text-muted-foreground hover:text-error opacity-0 group-hover:opacity-100 transition-opacity"
									onClick={() => onDeleteRelationship(rel.id)}
									title="Remove link"
								>
									<X className="h-3 w-3" />
								</Button>
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}

function ObjectPicker({
	allObjects,
	excludeIds,
	onSelect,
	onCancel,
}: {
	allObjects: ObjectResponse[]
	excludeIds: Set<string>
	onSelect: (id: string) => void
	onCancel: () => void
}) {
	const [search, setSearch] = useState('')

	const candidates = allObjects
		.filter((o) => !excludeIds.has(o.id))
		.filter(
			(o) =>
				!search ||
				o.title?.toLowerCase().includes(search.toLowerCase()) ||
				o.type.includes(search.toLowerCase()),
		)
		.slice(0, 10)

	return (
		<div className="mb-2 pl-4 rounded border border-border bg-card p-2">
			<input
				type="text"
				value={search}
				onChange={(e) => setSearch(e.target.value)}
				placeholder="Search objects to link..."
				className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:border-ring outline-none mb-1"
			/>
			<div className="max-h-32 overflow-auto space-y-0.5">
				{candidates.map((obj) => (
					<Button
						key={obj.id}
						variant="ghost"
						className="w-full justify-start"
						onClick={() => onSelect(obj.id)}
					>
						<span className="flex-1 truncate">{obj.title || 'Untitled'}</span>
						<TypeBadge type={obj.type} />
					</Button>
				))}
				{candidates.length === 0 && (
					<p className="text-xs text-muted-foreground py-1 px-2">No objects found</p>
				)}
			</div>
			<Button variant="ghost" size="sm" className="mt-1" onClick={onCancel}>
				Cancel
			</Button>
		</div>
	)
}

function AddLinkForm({
	objectId,
	objectType,
	allObjects,
	relationshipTypes,
	existingRelationships,
	onCreateRelationship,
}: {
	objectId: string
	objectType: string
	allObjects: ObjectResponse[]
	relationshipTypes: string[]
	existingRelationships: RelationshipResponse[]
	onCreateRelationship: (data: CreateRelationshipInput) => void
}) {
	const [open, setOpen] = useState(false)
	const [relType, setRelType] = useState(relationshipTypes[0] ?? 'relates_to')
	const [search, setSearch] = useState('')

	const existingIds = new Set(existingRelationships.flatMap((r) => [r.sourceId, r.targetId]))

	const candidates = allObjects
		.filter((o) => o.id !== objectId && !existingIds.has(o.id))
		.filter(
			(o) =>
				!search ||
				o.title?.toLowerCase().includes(search.toLowerCase()) ||
				o.type.includes(search.toLowerCase()),
		)
		.slice(0, 10)

	const handleLink = (targetId: string) => {
		const targetObj = allObjects.find((o) => o.id === targetId)
		onCreateRelationship({
			source_type: objectType,
			source_id: objectId,
			target_type: targetObj?.type ?? objectType,
			target_id: targetId,
			type: relType,
		})
		setOpen(false)
		setSearch('')
	}

	if (!open) {
		return (
			<Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
				+ Add link
			</Button>
		)
	}

	return (
		<div className="rounded border border-border bg-card p-3 space-y-2">
			<div className="flex items-center gap-2">
				<label className="text-xs text-muted-foreground" htmlFor="rel-type-select">
					Type:
				</label>
				<Select value={relType} onValueChange={setRelType}>
					<SelectTrigger id="rel-type-select">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{relationshipTypes.map((t) => (
							<SelectItem key={t} value={t}>
								{t.replace(/_/g, ' ')}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<input
				type="text"
				value={search}
				onChange={(e) => setSearch(e.target.value)}
				placeholder="Search objects..."
				className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:border-ring outline-none"
			/>
			<div className="max-h-32 overflow-auto space-y-0.5">
				{candidates.map((obj) => (
					<Button
						key={obj.id}
						variant="ghost"
						className="w-full justify-start"
						onClick={() => handleLink(obj.id)}
					>
						<span className="flex-1 truncate">{obj.title || 'Untitled'}</span>
						<TypeBadge type={obj.type} />
						<StatusBadge status={obj.status} />
					</Button>
				))}
				{candidates.length === 0 && (
					<p className="text-xs text-muted-foreground py-1 px-2">No objects found</p>
				)}
			</div>
			<Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
				Cancel
			</Button>
		</div>
	)
}
