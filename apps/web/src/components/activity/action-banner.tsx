import { useActor } from '@/hooks/use-actors'
import type { EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ArrowDown, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ActorAvatar } from '../shared/actor-avatar'

interface ActionBannerProps {
	events: EventResponse[] | undefined
	workspaceId: string
}

interface DecisionItem {
	eventId: number
	actorId: string
	decisionType: string
	label: string
}

function extractDecisions(events: EventResponse[]): DecisionItem[] {
	const items: DecisionItem[] = []
	for (const event of events) {
		if (event.action !== 'commented') continue
		const metadata = event.data?.metadata as Record<string, unknown> | undefined
		const decisionType = metadata?.decision_type
		if (typeof decisionType !== 'string' || !decisionType) continue
		const label =
			typeof metadata?.label === 'string' ? metadata.label : decisionType.replace(/_/g, ' ')
		items.push({
			eventId: event.id,
			actorId: event.actorId,
			decisionType,
			label,
		})
	}
	return items
}

export function ActionBanner({ events, workspaceId: _workspaceId }: ActionBannerProps) {
	const [dismissed, setDismissed] = useState<Set<number>>(new Set())

	const decisions = useMemo(() => extractDecisions(events ?? []), [events])
	const visible = useMemo(
		() => decisions.filter((d) => !dismissed.has(d.eventId)),
		[decisions, dismissed],
	)

	const dismiss = (eventId: number) => {
		setDismissed((prev) => {
			const next = new Set(prev)
			next.add(eventId)
			return next
		})
	}

	if (visible.length === 0) return null

	return (
		<div
			className={cn(
				'sticky top-0 z-10',
				'-mx-4 md:-mx-8 mb-6 px-4 md:px-8 py-2.5',
				'bg-background border-y border-border',
			)}
		>
			<div className="max-w-3xl mx-auto flex flex-wrap items-center gap-2">
				<span className="text-xs text-muted-foreground shrink-0">Needs your decision</span>
				{visible.map((item) => (
					<DecisionPill key={item.eventId} item={item} onDismiss={() => dismiss(item.eventId)} />
				))}
			</div>
		</div>
	)
}

function DecisionPill({
	item,
	onDismiss,
}: {
	item: DecisionItem
	onDismiss: () => void
}) {
	const { data: actor } = useActor(item.actorId)

	const jumpToComment = () => {
		document
			.getElementById(`comment-${item.eventId}`)
			?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
	}

	return (
		<div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs">
			{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
			<span className="font-medium">{actor?.name ?? 'Agent'}</span>
			<span className="text-muted-foreground">·</span>
			<span className="max-w-[120px] truncate text-muted-foreground">{item.label}</span>
			<button
				type="button"
				onClick={jumpToComment}
				className="ml-0.5 rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
				aria-label="Jump to comment"
			>
				<ArrowDown size={10} />
			</button>
			<button
				type="button"
				onClick={onDismiss}
				className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
				aria-label={`Dismiss ${actor?.name ?? 'agent'} decision`}
			>
				<X size={10} />
			</button>
		</div>
	)
}
