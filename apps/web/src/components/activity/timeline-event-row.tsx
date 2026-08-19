import { ObjectReference } from '@/components/shared/object-reference'
import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import type { EventResponse, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'

/**
 * The non-comment reading of one activity row, shared by every timeline in the
 * app — object detail's stream and the loop's Activity section render the same
 * spine, so a session or a status move looks identical wherever it is read.
 */
export type ChipTone = 'status' | 'session' | 'link' | 'update' | 'created' | 'signal'

export const CHIP_TONE_CLASSES: Record<ChipTone, string> = {
	status: 'border-border bg-background text-secondary-foreground',
	session: 'border-border bg-background text-secondary-foreground',
	link: 'border-border bg-background text-muted-foreground',
	update: 'border-border bg-background text-muted-foreground',
	created: 'border-border bg-background text-muted-foreground',
	signal: 'border-transparent bg-destructive/10 text-destructive',
}

export const DOT_TONE_CLASSES: Record<ChipTone, string> = {
	status: 'border-foreground',
	session: 'border-primary',
	link: 'border-border-strong',
	update: 'border-border-strong',
	created: 'border-border-strong',
	signal: 'border-destructive',
}

export function eventChip(event: EventResponse): { label: string; tone: ChipTone } {
	const { action } = event
	if (action === 'status_changed') return { label: 'Status', tone: 'status' }
	if (action.startsWith('session_')) {
		const failed = action === 'session_failed' || action === 'session_timeout'
		return { label: 'Session', tone: failed ? 'signal' : 'session' }
	}
	if (action === 'trigger_fired') return { label: 'Trigger', tone: 'session' }
	if (action === 'created') return { label: 'Created', tone: 'created' }
	if (action === 'deleted') return { label: 'Deleted', tone: 'signal' }
	if (action === 'verified' || action === 'unverified') return { label: 'Verified', tone: 'update' }
	return { label: 'Update', tone: 'update' }
}

export interface TimelineEventReference {
	verb: string
	objectId: string
	object?: ObjectResponse
}

export function TimelineEventRow({
	time,
	actorName,
	text,
	tone,
	workspaceId,
	isRelationship,
	statusLabel,
	reference,
}: {
	time: string | null
	actorName: string
	text: string
	tone: ChipTone
	workspaceId: string
	/** Edge rows read `<when> <verb> <object chip>` behind a square node —
	 *  the mockup's `tl.isRel`, not a sentence. */
	isRelationship?: boolean
	/** Only a status move carries a chip; it names the state the object landed
	 *  in. Every other event says what happened in its own sentence. */
	statusLabel?: string | null
	reference?: TimelineEventReference
}) {
	if (isRelationship && reference) {
		return (
			<div className="relative flex flex-wrap items-center gap-x-2.5 gap-y-1 py-[7px] pl-9">
				<span
					aria-hidden="true"
					className="absolute left-[10px] top-3.5 size-2 rounded-[2px] border-[1.5px] border-border-strong bg-background"
				/>
				{time && (
					<RelativeTime
						date={time}
						className="w-[46px] shrink-0 text-[10px] tabular-nums text-border-strong"
					/>
				)}
				<span className="shrink-0 text-[12.5px] text-muted-foreground">{reference.verb}</span>
				<ObjectReference
					objectId={reference.objectId}
					workspaceId={workspaceId}
					object={reference.object}
					variant="inline"
					className="min-w-0 text-xs"
				/>
			</div>
		)
	}

	return (
		// A hollow 8px node on the rail, the time in its own 46px column, then one
		// sentence — the event's weight comes from the bold actor name, not from a
		// filled dot or an uppercase badge.
		<div className="relative py-2 pl-9">
			<span
				aria-hidden="true"
				className={cn(
					'absolute left-[10px] top-[13px] size-2 rounded-full border-2 bg-background',
					DOT_TONE_CLASSES[tone],
				)}
			/>
			<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[12.5px] leading-[1.45]">
				{time && (
					<RelativeTime
						date={time}
						className="w-[46px] shrink-0 text-[10px] tabular-nums text-border-strong"
					/>
				)}
				<span className="font-bold text-foreground">{actorName}</span>
				<span className="min-w-0 text-muted-foreground">{text}</span>
				{statusLabel && (
					<Badge
						variant="outline"
						className={cn(
							'shrink-0 rounded-[7px] px-2 py-[3px] text-[11.5px] font-semibold',
							CHIP_TONE_CLASSES[tone],
						)}
					>
						{statusLabel.replace(/_/g, ' ')}
					</Badge>
				)}
				{reference && (
					<span className="flex min-w-0 items-baseline gap-1.5">
						<span className="shrink-0 text-xs text-muted-foreground">{reference.verb}</span>
						<ObjectReference
							objectId={reference.objectId}
							workspaceId={workspaceId}
							object={reference.object}
							variant="inline"
							className="min-w-0 text-xs"
						/>
					</span>
				)}
			</div>
		</div>
	)
}
