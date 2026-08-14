import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import type { ActorListItem, SessionResponse } from '@/lib/api'
import {
	formatChatCountLabel,
	getChatRowSnippet,
	partitionChatsWithPinned,
	sessionStateLabel,
	wasHandedOffByDefaultAgent,
} from '@/lib/chats'
import { cn } from '@/lib/cn'
import { ArrowRight } from 'lucide-react'
import { useMemo } from 'react'

const EMPTY_UNREAD: ReadonlySet<string> = new Set()

export interface ChatListDefaultAgent {
	id: string
	/** Display name of the default agent, used for the handed-off snippet. */
	name: string
}

export interface ChatListEmptyGreeting {
	/** Personalised greeting body, e.g. "Hi Sebk — I'm your Chief of Staff." */
	greeting: string
	/** Short paragraph under the greeting. */
	description: string
	/** Example prompts the operator can tap to seed a new conversation. */
	examples: string[]
	/** Fires when the operator taps an example prompt. */
	onExample: (prompt: string) => void
}

export function ChatList({
	sessions,
	actors,
	unreadSessionIds = EMPTY_UNREAD,
	defaultAgent,
	emptyGreeting,
	onSelectSession,
	onStartNew,
}: {
	sessions: SessionResponse[]
	actors?: ActorListItem[]
	/** Sessions with an open ask awaiting a human reply count as unread. */
	unreadSessionIds?: ReadonlySet<string>
	/** When set, the default agent's session is pinned above the recency groups. */
	defaultAgent?: ChatListDefaultAgent | null
	/** When set, the empty state renders the default agent's greeting instead of
	 * the generic "Start a new one" copy. */
	emptyGreeting?: ChatListEmptyGreeting | null
	onSelectSession: (session: SessionResponse) => void
	onStartNew: () => void
}) {
	const actorById = useMemo(() => new Map((actors ?? []).map((a) => [a.id, a])), [actors])
	const { pinned, groups } = useMemo(
		() => partitionChatsWithPinned(sessions, defaultAgent?.id ?? null),
		[sessions, defaultAgent?.id],
	)

	if (pinned.length === 0 && groups.length === 0) {
		return (
			<div data-testid="chats-list">
				{emptyGreeting ? (
					<ChiefOfStaffEmpty greeting={emptyGreeting} />
				) : (
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
				)}
			</div>
		)
	}

	const total = sessions.length

	return (
		<div className="space-y-6" data-testid="chats-list">
			{pinned.length > 0 && (
				<section aria-label="Pinned · your default agent">
					<h2 className="mb-1 px-2 text-[10px] font-medium uppercase tracking-[0.11em] text-cos">
						Pinned · your default agent
					</h2>
					<div className="space-y-0.5">
						{pinned.map((session) => (
							<ChatRow
								key={session.id}
								session={session}
								actor={session.actorId ? actorById.get(session.actorId) : undefined}
								unread={unreadSessionIds.has(session.id)}
								onSelect={() => onSelectSession(session)}
							/>
						))}
					</div>
				</section>
			)}
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
								handedOffLabel={
									wasHandedOffByDefaultAgent(session, defaultAgent?.id ?? null)
										? `${defaultAgent?.name ?? 'CoS'} handed off`
										: null
								}
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
	handedOffLabel,
	onSelect,
}: {
	session: SessionResponse
	actor?: ActorListItem
	unread: boolean
	/** Purple lead-in on the snippet — set when the default agent routed this thread. */
	handedOffLabel?: string | null
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
				{(snippet || handedOffLabel) && (
					<p className="line-clamp-2 break-words text-xs leading-[1.4] text-text-muted">
						{handedOffLabel && (
							<>
								<span className="font-semibold text-cos">{handedOffLabel}</span>
								{snippet ? ' · ' : ''}
							</>
						)}
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

function ChiefOfStaffEmpty({ greeting }: { greeting: ChatListEmptyGreeting }) {
	return (
		<div
			className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl border border-cos-tint-border bg-cos-tint px-6 py-8 text-center"
			data-testid="chats-list-cos-empty"
		>
			<span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-cos">
				Your workspace&apos;s default agent
			</span>
			<h2 className="text-lg font-semibold tracking-tight text-foreground">{greeting.greeting}</h2>
			<p className="max-w-sm text-[13px] leading-relaxed text-text-muted">{greeting.description}</p>
			{greeting.examples.length > 0 && (
				<div className="flex w-full flex-col gap-2 pt-1">
					{greeting.examples.map((prompt) => (
						<button
							key={prompt}
							type="button"
							onClick={() => greeting.onExample(prompt)}
							className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-md border border-border bg-background px-4 py-2 text-left text-[13px] text-foreground transition-colors hover:border-cos hover:text-cos"
						>
							<span className="min-w-0 flex-1 truncate">{prompt}</span>
							<ArrowRight size={14} className="shrink-0 text-cos" />
						</button>
					))}
				</div>
			)}
		</div>
	)
}
