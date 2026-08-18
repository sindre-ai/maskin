import type { DisplayPanelColumn } from '@/components/objects/data-table/display-panel'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import type { ActorListItem, NotificationResponse, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getTypeColor } from '@/lib/constants'
import { Link } from '@tanstack/react-router'
import type { VisibilityState } from '@tanstack/react-table'
import { ArrowRight } from 'lucide-react'

interface BoardCardProps {
	object: ObjectResponse
	workspaceId: string
	actors?: ActorListItem[]
	isSelected?: boolean
	columns?: DisplayPanelColumn[]
	columnVisibility?: VisibilityState
	/** Pending ask targeting this object — renders the amber "Waiting on you"
	 *  pill (mockup 984). */
	ask?: NotificationResponse
	/** Advance the card to the next column. Rendered as the `→` affordance in
	 *  the title row (mockup 983); omitted on the last column. */
	onAdvance?: () => void
	advanceLabel?: string
}

export function BoardCard({
	object,
	workspaceId,
	actors,
	isSelected,
	columns = [],
	columnVisibility,
	ask,
	onAdvance,
	advanceLabel,
}: BoardCardProps) {
	const driver = object.driver ? actors?.find((a) => a.id === object.driver) : null
	const availableProperties =
		columns.length > 0
			? columns
			: [
					{ id: 'status', label: 'Status', canHide: true },
					{ id: 'type', label: 'Type', canHide: true },
					{ id: 'driver', label: 'Driver', canHide: true },
					{ id: 'updatedAt', label: 'Updated', canHide: true },
				]
	const visibleProperties = availableProperties.filter(
		(column) => column.id !== 'title' && columnVisibility?.[column.id] !== false,
	)
	const showStatus = isPropertyVisible('status', visibleProperties)
	const hasPendingAsk = ask?.status === 'pending'
	const typeDot = getTypeColor(object.type)

	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: object.id }}
			data-testid="board-card"
			data-state={isSelected ? 'selected' : undefined}
			aria-selected={isSelected}
			className={cn(
				'relative flex flex-col gap-2 rounded-xl border border-border bg-card p-3 text-sm transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				'data-[state=selected]:border-accent data-[state=selected]:bg-accent/40 data-[state=selected]:ring-2 data-[state=selected]:ring-accent/30',
			)}
		>
			<div className="flex items-start gap-2">
				<span
					aria-hidden="true"
					className={cn('mt-1 size-2 shrink-0 rounded-[2px] bg-current', typeDot.text)}
				/>
				<span className="line-clamp-2 min-w-0 flex-1 font-semibold text-foreground">
					{object.title || 'Untitled'}
				</span>
				{showStatus && <StatusBadge status={object.status} className="shrink-0" />}
				{onAdvance && (
					// Always rendered at full opacity — a hover-only reveal would be
					// unreachable on touch (see .claude/rules/verification.md).
					<button
						type="button"
						title={advanceLabel}
						aria-label={advanceLabel ?? 'Move to next column'}
						onClick={(event) => {
							event.preventDefault()
							event.stopPropagation()
							onAdvance()
						}}
						className="grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
					>
						<ArrowRight size={12} aria-hidden="true" />
					</button>
				)}
			</div>

			{hasPendingAsk && (
				<span className="w-fit rounded-full border border-ask-border bg-ask-surface px-2 py-0.5 text-[10px] font-bold leading-none text-warning">
					Waiting on you
				</span>
			)}

			{object.activeSessionId && (
				<AgentWorkingBadge sessionId={object.activeSessionId} workspaceId={workspaceId} />
			)}

			{visibleProperties.length > 0 && (
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
					{visibleProperties.map((property) => (
						<PropertyValue
							key={property.id}
							property={property}
							object={object}
							actors={actors}
							driver={driver}
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
	driver,
}: {
	property: DisplayPanelColumn
	object: ObjectResponse
	actors?: ActorListItem[]
	driver?: ActorListItem | null
}) {
	switch (property.id) {
		case 'status':
			return null
		case 'type':
			return <TypeBadge type={object.type} />
		// The route's Display panel emits `driver` column ids; the card cased on
		// the retired `owner` id, so the avatar never rendered on a board card.
		case 'driver':
			return driver ? (
				<ActorAvatar id={driver.id} name={driver.name} type={driver.type} className="shrink-0" />
			) : null
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
