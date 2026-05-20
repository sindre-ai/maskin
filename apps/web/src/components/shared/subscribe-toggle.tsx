import { Button } from '@/components/ui/button'
import { useSubscribe, useSubscribers, useUnsubscribe } from '@/hooks/use-subscriptions'
import { cn } from '@/lib/cn'
import { Bell, BellOff } from 'lucide-react'
import { ActorAvatar } from './actor-avatar'

const MAX_VISIBLE = 4

/**
 * Watchers UI for any subscribable entity. Renders a small stack of subscriber
 * avatars next to a bell toggle for the current actor.
 *
 * Entity-agnostic — accepts entityType + entityId so threads, sessions, etc.
 * can reuse this once they become subscribable on the backend.
 */
export function SubscribeToggle({
	workspaceId,
	entityType,
	entityId,
	isSubscribed,
	className,
}: {
	workspaceId: string
	entityType: string
	entityId: string
	isSubscribed: boolean | undefined
	className?: string
}) {
	const { data: subscribers } = useSubscribers(workspaceId, entityType, entityId)
	const subscribe = useSubscribe(workspaceId)
	const unsubscribe = useUnsubscribe(workspaceId)

	const list = subscribers?.actors ?? []
	const visible = list.slice(0, MAX_VISIBLE)
	const overflow = Math.max(0, list.length - MAX_VISIBLE)
	const pending = subscribe.isPending || unsubscribe.isPending

	const handleToggle = () => {
		if (isSubscribed) {
			unsubscribe.mutate({ entityType, entityId })
		} else {
			subscribe.mutate({ entityType, entityId })
		}
	}

	return (
		<div className={cn('inline-flex items-center gap-1', className)}>
			{visible.length > 0 && (
				<div className="flex items-center" title={list.map((a) => a.name).join(', ')}>
					{visible.map((actor, i) => (
						<ActorAvatar
							key={actor.id}
							name={actor.name}
							type={actor.type}
							size="sm"
							className={cn('ring-1 ring-bg-surface', i > 0 && '-ml-1.5')}
						/>
					))}
					{overflow > 0 && (
						<span className="-ml-1.5 inline-flex h-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs text-muted-foreground ring-1 ring-bg-surface">
							+{overflow}
						</span>
					)}
				</div>
			)}
			<Button
				variant="ghost"
				size="sm"
				onClick={handleToggle}
				disabled={pending}
				className="h-7 gap-1 px-2 text-xs"
				aria-label={
					isSubscribed ? `Unsubscribe from this ${entityType}` : `Subscribe to this ${entityType}`
				}
				title={
					isSubscribed
						? 'Unsubscribe — stop getting unread badges'
						: 'Subscribe — see unread badges for new comments'
				}
			>
				{isSubscribed ? <BellOff size={13} /> : <Bell size={13} />}
				{isSubscribed ? 'Watching' : 'Watch'}
			</Button>
		</div>
	)
}
