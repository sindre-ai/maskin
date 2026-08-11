import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import type { ActorListItem, SessionResponse } from '@/lib/api'
import {
	formatChatCountLabel,
	getChatRowSnippet,
	groupSessionsByRecency,
	sessionStateLabel,
} from '@/lib/chats'
import { cn } from '@/lib/cn'
import { ArrowRight } from 'lucide-react'
import { useMemo } from 'react'

const EMPTY_UNREAD: ReadonlySet<string> = new Set()

export function ChatList({
	sessions,
	actors,
	unreadSessionIds = EMPTY_UNREAD,
	onSelectSession,
	onStartNew,
}: {
	sessions: SessionResponse[]
	actors?: ActorListItem[]
	/** Sessions with an open ask awaiting a human reply count as unread. */
	unreadSessionIds?: ReadonlySet<string>
	onSelectSession: (session: SessionResponse) => void
	onStartNew: () => void
}) {
	const actorById = useMemo(() => new Map((actors ?? []).map((a) => [a.id, a])), [actors])
	const groups = useMemo(() => groupSessionsByRecency(sessions), [sessions])

	if (groups.length === 0) {
		return (
			<div data-testid="chats-list">
				<EmptyState
					title="No conversations here"
					description="Chats with your workspace agents land here, newest first."
					action={
						<Button size="sm" onClick={onStartNew} className="min-h-[44px]">
							Start a new one
							<ArrowRight size={16} />
						</Button>
					}
				/>
			</div>
		)
	}

	const total = sessions.length

	return (
		<div className="space-y-6" data-testid="chats-list">
			{groups.map((group) => (
				<section key={group.bucket} aria-label={group.label}>
					<h2 className="mb-1 px-2 text-[10px] font-medium uppercase tracking-[0.11em] text-muted-foreground">
						{group.label}
					</h2>
					<div className="space-y-0.5">
						{group.items.map((session) => (
							<ChatRow
								key={session.id}
								session={session}
								actor={session.actorId ? actorById.get(session.actorId) : undefined}
								unread={unreadSessionIds.has(session.id)}
								onSelect={() => onSelectSession(session)}
							/>
						))}
					</div>
					{group.bucket === 'earlier' && (
						<p className="mt-2 px-2 text-center text-[10px] text-muted-foreground">
							That&apos;s the whole history — {formatChatCountLabel(total)} in this workspace.
						</p>
					)}
				</section>
			))}
		</div>
	)
}

export function ChatRow({
	session,
	actor,
	unread,
	onSelect,
}: {
	session: SessionResponse
	actor?: ActorListItem
	unread: boolean
	onSelect: () => void
}) {
	const snippet = getChatRowSnippet(session)

	return (
		<button
			type="button"
			onClick={onSelect}
			className="flex w-full min-h-[44px] cursor-pointer items-start gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-secondary/50"
		>
			<ActorAvatar
				name={actor?.name ?? '?'}
				type={actor?.type ?? 'agent'}
				id={actor?.id}
				size="md"
				className="mt-0.5 shrink-0"
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex min-w-0 items-center gap-1.5">
					{unread && (
						<span aria-label="Unread" className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
					)}
					<span
						className={cn(
							'min-w-0 flex-1 truncate text-[13px] text-foreground',
							unread ? 'font-semibold' : 'font-medium',
						)}
					>
						{session.actionPrompt || 'Untitled conversation'}
					</span>
					{session.updatedAt && (
						<RelativeTime
							date={session.updatedAt}
							className="shrink-0 text-[10px] text-muted-foreground"
						/>
					)}
				</div>
				{snippet && (
					<p className="line-clamp-2 break-words text-xs leading-[1.4] text-text-muted">
						{snippet}
					</p>
				)}
			</div>
			<span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
				{sessionStateLabel(session.status)}
			</span>
		</button>
	)
}
