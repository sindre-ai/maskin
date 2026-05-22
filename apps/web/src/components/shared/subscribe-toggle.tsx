import { useSubscribe, useSubscribers, useUnsubscribe } from '@/hooks/use-subscriptions'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { Plus } from 'lucide-react'
import { ActorAvatar } from './actor-avatar'

const MAX_VISIBLE = 4

/**
 * Watchers UI for any subscribable entity. Renders a stack of subscriber
 * avatars; the current actor's avatar is clickable to unsubscribe. A `+`
 * button appears at the end of the row to subscribe.
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
	const currentActorId = getStoredActor()?.id

	const list = subscribers?.actors ?? []
	const visible = list.slice(0, MAX_VISIBLE)
	const overflow = Math.max(0, list.length - MAX_VISIBLE)
	const pending = subscribe.isPending || unsubscribe.isPending

	return (
		<div className={cn('inline-flex items-center gap-1', className)}>
			{visible.length > 0 && (
				<div className="flex items-center" title={list.map((a) => a.name).join(', ')}>
					{visible.map((actor, i) => {
						const avatar = (
							<ActorAvatar
								name={actor.name}
								type={actor.type}
								size="sm"
								className={cn('ring-1 ring-bg-surface', i > 0 && '-ml-1.5')}
							/>
						)
						if (actor.id === currentActorId) {
							return (
								<button
									key={actor.id}
									type="button"
									onClick={() => unsubscribe.mutate({ entityType, entityId })}
									disabled={pending}
									aria-label={`Unsubscribe from this ${entityType}`}
									title="Click your avatar to unsubscribe — stop getting unread badges"
									className="inline-flex rounded-full transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-50"
								>
									{avatar}
								</button>
							)
						}
						return (
							<span key={actor.id} className="inline-flex">
								{avatar}
							</span>
						)
					})}
					{overflow > 0 && (
						<span className="-ml-1.5 inline-flex h-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs text-muted-foreground ring-1 ring-bg-surface">
							+{overflow}
						</span>
					)}
				</div>
			)}
			{!isSubscribed && (
				<button
					type="button"
					onClick={() => subscribe.mutate({ entityType, entityId })}
					disabled={pending}
					aria-label={`Subscribe to this ${entityType}`}
					title="Subscribe — see unread badges for new comments"
					className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-border text-text-secondary transition-colors hover:border-border-hover hover:bg-bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
				>
					<Plus size={12} />
				</button>
			)}
		</div>
	)
}
