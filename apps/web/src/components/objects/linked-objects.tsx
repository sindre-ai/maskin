import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
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
import { AgentWorkingBadge } from '../shared/agent-working-badge'
import { StatusBadge } from '../shared/status-badge'
import { TypeBadge } from '../shared/type-badge'

interface ResolvedRelationship {
	rel: RelationshipResponse
	object: ObjectResponse
}

function resolveLinkedObjectId(rel: RelationshipResponse, currentId: string): string {
	return rel.sourceId === currentId ? rel.targetId : rel.sourceId
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
	const [activeFilter, setActiveFilter] = useState<string>('all')
	const [showAddLink, setShowAddLink] = useState(false)

	const objectMap = useMemo(() => new Map(allObjects.map((o) => [o.id, o])), [allObjects])

	// Merge all relationships into a flat list with resolved objects
	const allRelationships = useMemo(() => {
		const allRels = [...asSource, ...asTarget]
		const seen = new Set<string>()
		const resolved: ResolvedRelationship[] = []

		for (const rel of allRels) {
			if (seen.has(rel.id)) continue
			seen.add(rel.id)

			const linkedId = resolveLinkedObjectId(rel, objectId)
			const obj = objectMap.get(linkedId)
			if (obj) {
				resolved.push({ rel, object: obj })
			}
		}

		return resolved
	}, [asSource, asTarget, objectId, objectMap])

	// Compute type counts for filter buttons
	const typeCounts = useMemo(() => {
		const counts: Record<string, number> = {}
		for (const { object } of allRelationships) {
			counts[object.type] = (counts[object.type] ?? 0) + 1
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
			: allRelationships.filter((r) => r.object.type === effectiveFilter)

	const totalCount = allRelationships.length
	const existingRelationships = [...asSource, ...asTarget]

	return (
		<div>
			{/* Header */}
			<div className="flex items-center gap-2 mb-2">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Related ({totalCount})
				</h3>
				<div className="flex-1" />
				<Button variant="ghost" size="sm" onClick={() => setShowAddLink(!showAddLink)}>
					+ link
				</Button>
			</div>

			{/* Filter buttons — only when 2+ types */}
			{uniqueTypes.length >= 2 && (
				<div className="flex items-center gap-1 mb-3">
					<Button
						variant={effectiveFilter === 'all' ? 'secondary' : 'ghost'}
						size="sm"
						onClick={() => setActiveFilter('all')}
					>
						All {totalCount}
					</Button>
					{uniqueTypes.map((type) => (
						<Button
							key={type}
							variant={effectiveFilter === type ? 'secondary' : 'ghost'}
							size="sm"
							onClick={() => setActiveFilter(type)}
						>
							{type}s {typeCounts[type]}
						</Button>
					))}
				</div>
			)}

			{/* Add link form */}
			{showAddLink && (
				<AddLinkForm
					objectId={objectId}
					objectType={objectType}
					allObjects={allObjects}
					relationshipTypes={relationshipTypes}
					existingRelationships={existingRelationships}
					onCreateRelationship={onCreateRelationship}
					onClose={() => setShowAddLink(false)}
				/>
			)}

			{/* Related rows */}
			{filteredRelationships.length > 0 && (
				<div className="space-y-1">
					{filteredRelationships.map(({ rel, object: obj }) => (
						<div key={rel.id} className="flex items-center gap-2 group">
							{onNavigate ? (
								<button
									type="button"
									onClick={() => onNavigate(workspaceId, obj.id)}
									className="flex items-center gap-2 flex-1 rounded px-2 py-1 text-sm text-muted-foreground hover:text-accent-foreground hover:bg-accent/50 text-left"
								>
									<span className="flex-1 truncate">{obj.title || 'Untitled'}</span>
									<Badge variant="outline" className="text-[10px] font-normal">
										{rel.type.replace(/_/g, ' ')}
									</Badge>
									<StatusBadge status={obj.status} />
									<TypeBadge type={obj.type} />
								</button>
							) : (
								<Link
									to="/$workspaceId/objects/$objectId"
									params={{ workspaceId, objectId: obj.id }}
									className="flex items-center gap-2 flex-1 rounded px-2 py-1 text-sm text-muted-foreground hover:text-accent-foreground hover:bg-accent/50"
								>
									<span className="flex-1 truncate">{obj.title || 'Untitled'}</span>
									<Badge variant="outline" className="text-[10px] font-normal">
										{rel.type.replace(/_/g, ' ')}
									</Badge>
									<StatusBadge status={obj.status} />
									<TypeBadge type={obj.type} />
								</Link>
							)}
							{obj.activeSessionId && (
								<AgentWorkingBadge sessionId={obj.activeSessionId} workspaceId={workspaceId} />
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
					))}
				</div>
			)}
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
	const { data: objectsResponse } = useObjects(workspaceId, { limit: '100' })
	const allObjects = objectsResponse?.data ?? []
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
			allObjects={allObjects}
			relationshipTypes={relationshipTypes}
			onCreateRelationship={(data) => createRelationship.mutate(data)}
			onDeleteRelationship={(id) => deleteRelationship.mutate(id)}
		/>
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
		<div className="mb-2 rounded border border-border bg-card p-2">
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
	onClose,
}: {
	objectId: string
	objectType: string
	allObjects: ObjectResponse[]
	relationshipTypes: string[]
	existingRelationships: RelationshipResponse[]
	onCreateRelationship: (data: CreateRelationshipInput) => void
	onClose: () => void
}) {
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
		onClose()
		setSearch('')
	}

	return (
		<div className="rounded border border-border bg-card p-3 space-y-2 mb-3">
			<div className="flex items-center gap-2">
				<Label htmlFor="rel-type-select">Type:</Label>
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
			<Button variant="ghost" size="sm" onClick={onClose}>
				Cancel
			</Button>
		</div>
	)
}
