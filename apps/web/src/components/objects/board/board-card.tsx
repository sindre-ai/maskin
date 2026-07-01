import type { DisplayPanelColumn } from '@/components/objects/data-table/display-panel'
import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import type { VisibilityState } from '@tanstack/react-table'

interface BoardCardProps {
	object: ObjectResponse
	workspaceId: string
	actors?: ActorListItem[]
	isSelected?: boolean
	columns?: DisplayPanelColumn[]
	columnVisibility?: VisibilityState
}

export function BoardCard({
	object,
	workspaceId,
	actors,
	isSelected,
	columns = [],
	columnVisibility,
}: BoardCardProps) {
	const owner = object.driver ? actors?.find((a) => a.id === object.driver) : null
	const availableProperties =
		columns.length > 0
			? columns
			: [
					{ id: 'status', label: 'Status', canHide: true },
					{ id: 'type', label: 'Type', canHide: true },
					{ id: 'owner', label: 'Owner', canHide: true },
					{ id: 'updatedAt', label: 'Updated', canHide: true },
				]
	const visibleProperties = availableProperties.filter(
		(column) => column.id !== 'title' && columnVisibility?.[column.id] !== false,
	)
	const showStatus = isPropertyVisible('status', visibleProperties)

	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: object.id }}
			data-testid="board-card"
			data-state={isSelected ? 'selected' : undefined}
			aria-selected={isSelected}
			className={cn(
				'relative flex flex-col gap-[var(--space-2)] rounded-md border border-border bg-card p-[var(--space-3)] text-sm transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				'data-[state=selected]:border-accent data-[state=selected]:bg-accent/40 data-[state=selected]:ring-2 data-[state=selected]:ring-accent/30',
			)}
		>
			<div className="flex items-start justify-between gap-[var(--space-2)]">
				<span className="line-clamp-2 min-w-0 font-medium text-foreground">
					{object.title || 'Untitled'}
				</span>
				{showStatus && <StatusBadge status={object.status} className="shrink-0" />}
			</div>

			{object.activeSessionId && (
				<AgentWorkingBadge sessionId={object.activeSessionId} workspaceId={workspaceId} />
			)}

			{visibleProperties.length > 0 && (
				<div className="flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)] text-xs text-muted-foreground">
					{visibleProperties.map((property) => (
						<PropertyValue
							key={property.id}
							property={property}
							object={object}
							actors={actors}
							ownerName={owner?.name}
						/>
					))}
				</div>
			)}
		</Link>
	)
}

function isPropertyVisible(propertyId: string, visibleProperties: DisplayPanelColumn[]) {
	return visibleProperties.some((property) => property.id === propertyId)
}

function PropertyValue({
	property,
	object,
	actors,
	ownerName,
}: {
	property: DisplayPanelColumn
	object: ObjectResponse
	actors?: ActorListItem[]
	ownerName?: string
}) {
	switch (property.id) {
		case 'status':
			return null
		case 'type':
			return <TypeBadge type={object.type} />
		case 'owner':
			return ownerName ? <span className="truncate">{ownerName}</span> : null
		case 'createdBy': {
			const actor = actors?.find((a) => a.id === object.createdBy)
			return actor ? <span className="truncate">{actor.name}</span> : null
		}
		case 'createdAt':
			return object.createdAt ? <RelativeTime date={object.createdAt} className="shrink-0" /> : null
		case 'updatedAt':
			return object.updatedAt ? (
				<RelativeTime date={object.updatedAt} className="ml-auto shrink-0" />
			) : null
		default:
			return <MetadataProperty property={property} object={object} />
	}
}

function MetadataProperty({
	property,
	object,
}: {
	property: DisplayPanelColumn
	object: ObjectResponse
}) {
	if (!property.id.startsWith('metadata.')) return null
	const key = property.id.slice('metadata.'.length)
	const metadata = object.metadata as Record<string, unknown> | null
	const value = metadata?.[key]
	if (value == null || value === '') return null
	return (
		<span className="min-w-0 truncate">
			<span className="text-muted-foreground/80">{property.label}: </span>
			{String(value)}
		</span>
	)
}
