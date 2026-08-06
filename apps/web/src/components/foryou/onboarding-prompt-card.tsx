import { CommentInput } from '@/components/activity/comment-input'
import { useEntityEvents } from '@/hooks/use-events'
import { useMarkRead } from '@/hooks/use-subscriptions'
import type { UnreadItem } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface OnboardingPromptCardProps {
	workspaceId: string
	item: UnreadItem
}

const PREFETCH_ROOT_MARGIN = '400px'

export function OnboardingPromptCard({ workspaceId, item }: OnboardingPromptCardProps) {
	const objectId = item.entity_id

	const cardRef = useRef<HTMLDivElement>(null)
	const [hasBeenVisible, setHasBeenVisible] = useState(false)
	useEffect(() => {
		if (hasBeenVisible) return
		const node = cardRef.current
		if (!node) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setHasBeenVisible(true)
					observer.disconnect()
				}
			},
			{ rootMargin: PREFETCH_ROOT_MARGIN },
		)
		observer.observe(node)
		return () => observer.disconnect()
	}, [hasBeenVisible])

	const { data: events } = useEntityEvents(workspaceId, objectId, {
		enabled: hasBeenVisible,
	})

	const currentActorId = getStoredActor()?.id ?? null

	// Latest unanswered prompt: the most recent top-level comment not from the human
	const latestPrompt = useMemo(() => {
		if (!events) return null
		const chronological = [...events].reverse()
		const agentComments = chronological.filter(
			(e) =>
				e.action === 'commented' &&
				!(e.data?.parentEventId as number | undefined) &&
				e.actorId !== currentActorId,
		)
		return agentComments[agentComments.length - 1] ?? null
	}, [events, currentActorId])

	const latestEventId = useMemo(() => {
		if (!events || events.length === 0) return 0
		return Math.max(...events.map((e) => e.id))
	}, [events])

	const markRead = useMarkRead(workspaceId)
	const handleMarkRead = useCallback(() => {
		const target = Math.max(item.latest_event_id ?? 0, latestEventId)
		if (target <= 0) return
		markRead.mutate({ entityType: item.entity_type, entityId: objectId, lastEventId: target })
	}, [markRead, item.entity_type, item.latest_event_id, objectId, latestEventId])

	const promptText =
		latestPrompt && typeof latestPrompt.data?.content === 'string'
			? latestPrompt.data.content
			: null

	const sessionTitle = item.object?.title ?? 'Getting your workspace ready'

	return (
		<div
			ref={cardRef}
			className="rounded-lg border border-border bg-card"
			data-testid="onboarding-prompt-card"
		>
			<div className="border-b border-border px-4 py-3">
				<p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
					{sessionTitle}
				</p>
			</div>

			<div className="px-4 py-6 min-h-24">
				{promptText ? (
					<p className="text-lg font-medium tracking-[-0.013em] leading-snug">{promptText}</p>
				) : (
					<p className="text-sm text-muted-foreground">Loading…</p>
				)}
			</div>

			<div className="border-t border-border px-4 py-3">
				<CommentInput
					workspaceId={workspaceId}
					objectId={objectId}
					parentEventId={latestPrompt?.id}
					onSubmitted={handleMarkRead}
				/>
			</div>
		</div>
	)
}
