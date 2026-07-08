import type { ObjectResponse, RelationshipResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { Link2, Trash2 } from 'lucide-react'
import { RelativeTime } from '../shared/relative-time'
import { StatusBadge } from '../shared/status-badge'
import { TypeBadge } from '../shared/type-badge'
import { Button } from '../ui/button'

interface RelationshipNodeProps {
	rel: RelationshipResponse
	linked: ObjectResponse | null
	workspaceId: string
	/** Direction relative to the current page object — `outbound` if current is source, `inbound` if target. */
	direction: 'outbound' | 'inbound'
	onDelete?: (relationshipId: string) => void
}

// Past-participle inverses for the known relationship verbs. The naive
// `${type}d by` suffix breaks on every type we ship today ("informsd by",
// "breaks intod by", "relates tod by"), so map the known ones explicitly and
// fall back to a "← {type}" marker for any future type.
const INBOUND_VERB: Record<string, string> = {
	informs: 'informed by',
	breaks_into: 'part of',
	blocks: 'blocked by',
	relates_to: 'related to',
	duplicates: 'duplicated by',
	attached: 'attached to',
}

function relationshipVerb(type: string, direction: 'outbound' | 'inbound'): string {
	if (direction === 'outbound') return type.replace(/_/g, ' ')
	return INBOUND_VERB[type] ?? `← ${type.replace(/_/g, ' ')}`
}

/**
 * Renders one relationship as a "graph node" row inside the activity timeline.
 * The phrasing reads as a sentence: "{type} {linked-object-title}", followed
 * by status, type badge, and the edge's createdAt timestamp.
 *
 * When the linked object is missing (deleted or unreadable), the row stays
 * present but muted with the linked id surfaced so the user can still see
 * the historical link.
 */
export function RelationshipNode({
	rel,
	linked,
	workspaceId,
	direction,
	onDelete,
}: RelationshipNodeProps) {
	const verb = relationshipVerb(rel.type, direction)
	const linkedId = direction === 'outbound' ? rel.targetId : rel.sourceId
	// Prefer the denormalized title for whichever side `linkedId` actually
	// refers to — falling back to the *other* side's title would show the
	// currently-viewed object's own title instead of the missing link's.
	const linkedTitle = direction === 'outbound' ? rel.targetTitle : rel.sourceTitle
	const title = linked?.title ?? linkedTitle ?? `Unknown (${linkedId.slice(0, 8)})`
	const isMissing = !linked

	return (
		<div className={cn('group flex items-start gap-2 py-2 animate-slide-in')}>
			<Link2 size={14} className="mt-1 text-muted-foreground shrink-0" aria-hidden />
			<div className="flex-1 min-w-0">
				<div className="flex items-baseline gap-1.5 text-sm flex-wrap">
					<span className="text-muted-foreground">{verb}</span>
					{linked ? (
						<Link
							to="/$workspaceId/objects/$objectId"
							params={{ workspaceId, objectId: linked.id }}
							className={cn('text-foreground hover:underline truncate text-sm min-w-0 max-w-full')}
						>
							{title}
						</Link>
					) : (
						<span className="text-muted-foreground line-through truncate text-sm min-w-0 max-w-full">
							{title}
						</span>
					)}
					{linked && <TypeBadge type={linked.type} />}
					{linked && <StatusBadge status={linked.status} />}
					{isMissing && (
						<span className="text-[10px] text-muted-foreground italic">unavailable</span>
					)}
					{rel.createdAt && (
						<RelativeTime date={rel.createdAt} className="text-muted-foreground text-xs" />
					)}
				</div>
			</div>
			{onDelete && (
				<Button
					variant="ghost"
					size="icon"
					className="h-6 w-6 opacity-0 group-hover:opacity-100"
					aria-label="Remove link"
					title="Remove link"
					onClick={() => onDelete(rel.id)}
				>
					<Trash2 size={12} />
				</Button>
			)}
		</div>
	)
}
