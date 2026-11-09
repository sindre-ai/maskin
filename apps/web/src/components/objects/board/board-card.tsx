import type { DisplayPanelColumn } from '@/components/objects/data-table/display-panel'
import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { useCanWrite } from '@/hooks/use-can-write'
import type { ActorListItem, NotificationResponse, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
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
	const canWrite = useCanWrite()
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
		(column) =>
			column.id !== 'title' &&
			// v3 cards carry the last-updated age only; "Created" is opt-in.
			(column.id === 'createdAt'
				? columnVisibility?.createdAt === true
				: columnVisibility?.[column.id] !== false),
	)
	const hasPendingAsk = ask?.status === 'pending'

	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: object.id }}
			data-testid="board-card"
			data-state={isSelected ? 'selected' : undefined}
			aria-selected={isSelected}
			className={cn(
				'relative flex flex-col gap-1.5 rounded-lg border border-border bg-card px-2.5 py-2 text-sm transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				// v11: a card that waits on the reader carries a brand rail on its left edge.
				hasPendingAsk && 'border-l-[3px] border-l-brand',
				// `accent` is a near-white background token in light mode, so it cannot
				// carry a resting-state indicator on a white card — `muted`/`brand` read
				// in both modes. Matches the v2 list row's selected state.
				'data-[state=selected]:border-brand data-[state=selected]:bg-muted data-[state=selected]:ring-2 data-[state=selected]:ring-brand/40',
			)}
		>
			<div className="flex items-start gap-2">
				<span className="line-clamp-3 min-w-0 flex-1 text-[13px] font-semibold leading-snug text-foreground">
					{object.title || 'Untitled'}
				</span>
				{onAdvance && (
					// `<span role="button">` rather than a native `<button>`: the whole
					// card is a `<Link>` (`<a>`), and `<button>` inside `<a>` is invalid
					// HTML (React 19 logs `<button> cannot be a descendant of <a>` on
					// every render). Always rendered at full opacity — a hover-only
					// reveal would be unreachable on touch (see .claude/rules/verification.md).
					<ViewerTooltip>
						{/* biome-ignore lint/a11y/useSemanticElements: `<button>` would be a descendant of the card's `<a>`, which is invalid HTML — see comment above. */}
						<span
							role="button"
							tabIndex={canWrite ? 0 : -1}
							title={advanceLabel}
							aria-label={advanceLabel ?? 'Move to next column'}
							aria-disabled={!canWrite || undefined}
							onClick={(event) => {
								event.preventDefault()
								event.stopPropagation()
								if (canWrite) onAdvance()
							}}
							onKeyDown={(event) => {
								if (event.key !== 'Enter' && event.key !== ' ') return
								event.preventDefault()
								event.stopPropagation()
								if (canWrite) onAdvance()
							}}
							className={cn(
								'grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
								canWrite
									? 'cursor-pointer hover:bg-muted hover:text-foreground'
									: 'cursor-not-allowed opacity-50',
							)}
						>
							<ArrowRight size={12} aria-hidden="true" />
						</span>
					</ViewerTooltip>
				)}
			</div>

			{hasPendingAsk && (
				<span className="text-[11.5px] font-semibold text-brand">
					To decide{driver ? ` · ${driver.name}` : ''}
				</span>
			)}

			{object.activeSessionId && (
				<AgentWorkingBadge sessionId={object.activeSessionId} workspaceId={workspaceId} />
			)}

			{visibleProperties.length > 0 && (
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
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
			// A board holds one type, so the column's own header already says it.
			return null
		// The route's Display panel emits `driver` column ids; the card cased on
		// the retired `owner` id, so the avatar never rendered on a board card.
		case 'driver':
			return driver ? <span className="truncate font-semibold">{driver.name}</span> : null
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
