import { CommentInput } from '@/components/activity/comment-input'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { DecisionOptionCard, DecisionOptionGrid } from '@/components/shared/decision-option-card'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { QueryStateError } from '@/components/shared/query-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { useActors } from '@/hooks/use-actors'
import { useEntityEvents } from '@/hooks/use-events'
import { trackForyouCardAction, trackForyouCardShown } from '@/lib/analytics'
import type { ActorListItem, EventResponse, UnreadItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	type CardAction,
	type CardKind,
	cardActions,
	cardBody,
	cardHeadline,
	classifyCardKind,
	decisionOf,
} from '@/lib/foryou-card-kind'
import { heldNote } from '@/lib/foryou-feed'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Check, ChevronDown, ChevronUp } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface DecidedOption {
	id: string
	label: string
}

interface FeedCardProps {
	workspaceId: string
	item: UnreadItem
	/** Expanded (`isFull`) vs collapsed (`isRow`) — Cards view expands them all. */
	expanded: boolean
	/** Absent in Cards view, where a card cannot be collapsed (mockup `heroGo`). */
	onToggleExpanded?: () => void
	decided: DecidedOption | null
	onDecide: (option: DecidedOption) => void
	/** The reader answered in this sitting — the card flips to "Waiting on …". */
	replied: boolean
	onReplied: () => void
	onMarkRead: () => void
}

/**
 * One card in the For You feed (Feed v4, lines 158–262). Three states:
 *
 * - **row** — one line: the ask, then status · who · how long it has been held,
 *   with the time on the right.
 * - **full** — the meta line (object, source, status, time), the ask as a
 *   headline, why it needs a person, the options side by side, and a composer.
 * - **done** — the green receipt with Undo, after an option has been taken.
 */
export function FeedCard({
	workspaceId,
	item,
	expanded,
	onToggleExpanded,
	decided,
	onDecide,
	replied,
	onReplied,
	onMarkRead,
}: FeedCardProps) {
	const objectId = item.entity_id
	const object = item.object
	const cardKind: CardKind = classifyCardKind(item)
	const decision = decisionOf(item)
	// The ask leads, not the object. `cardHeadline` falls back through the
	// comment's first line to the object title, so a card still reads sensibly
	// for a mention with no decision and for an item with no mention payload.
	const title = cardHeadline(item)
	// The headline is already the comment's opening line, so the body is only
	// what follows it — otherwise a one-line mention prints twice.
	const mentionBody = cardBody(item)
	const status = object?.status
	// The object's own name is context now, not the headline — it sits in the
	// meta line beside the type badge. Suppressed when the headline already fell
	// back to it, so the card doesn't print the same title twice.
	const rawObjectTitle = object?.title?.trim() ?? ''
	const objectTitle = rawObjectTitle === title ? '' : rawObjectTitle

	const { data: actors } = useActors(workspaceId)
	// Attribution follows the author of the comment that raised the card, NOT
	// the object's driver — the two can differ (e.g. an agent replies to a
	// human's task and the human is the driver, the agent is the sender).
	// Confusing them prints the reader's own name back at them on a card
	// authored by someone else.
	const senderId = item.latest_mention?.actor_id
	const sender = useMemo(
		() => (senderId ? actors?.find((actor) => actor.id === senderId) : undefined),
		[actors, senderId],
	)
	const who = sender?.name ?? 'the agent'

	const impressionFired = useRef(false)
	useEffect(() => {
		if (impressionFired.current) return
		impressionFired.current = true
		trackForyouCardShown({ card_kind: cardKind, card_id: objectId })
	}, [cardKind, objectId])

	// Options are the ones the agent authored on the comment, recommendation
	// last so it lands under the filled bar. A plain mention has nothing to
	// decide and shows only the composer.
	const options: readonly CardAction[] = useMemo(() => cardActions(item), [item])

	// The card is waiting on an agent once the reader has answered it.
	const waiting = !decided && replied
	const held = decided || waiting ? '' : heldNote(item.latest_activity_at)

	const [pendingId, setPendingId] = useState<string | null>(null)
	// The acknowledgement beat below posts a real reply when it fires, so the
	// timer has to die with the card. A bulk dismiss ("Dismiss all", Alt+U)
	// unmounts mid-beat, and an uncancelled timer would comment on a thread the
	// reader just cleared.
	const decideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	useEffect(
		() => () => {
			if (decideTimer.current) clearTimeout(decideTimer.current)
		},
		[],
	)
	const chooseOption = useCallback(
		(option: CardAction) => {
			if (pendingId) return
			trackForyouCardAction({ card_kind: cardKind, card_id: objectId, action_id: option.id })
			setPendingId(option.id)
			// Short beat on the bar before the card flips to its receipt, the way
			// the mockup acknowledges the tap.
			decideTimer.current = setTimeout(() => {
				decideTimer.current = null
				setPendingId(null)
				onDecide({ id: option.id, label: option.label })
			}, 260)
		},
		[cardKind, objectId, onDecide, pendingId],
	)

	if (decided) {
		return (
			<CardShell expanded={false}>
				<DecisionReceipt decided={decided} who={sender?.name} />
			</CardShell>
		)
	}

	if (!expanded) {
		return (
			<CardShell expanded={false}>
				<div className="group/card flex items-center gap-3 px-4 py-[13px] transition-colors duration-150 hover:bg-muted/40">
					<button
						type="button"
						aria-expanded={false}
						onClick={onToggleExpanded}
						className="flex min-w-0 flex-1 flex-col items-start text-left"
					>
						<span className="w-full truncate text-[13.5px] font-semibold leading-[1.35] tracking-[-0.008em] text-foreground">
							{title}
						</span>
						<span className="mt-[3px] flex w-full items-center gap-2 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground">
							{waiting ? (
								<span className="shrink-0 font-medium text-status-clustered-text">
									Waiting on {who}
								</span>
							) : (
								status && <StatusBadge status={status} variant="word" />
							)}
							<span className="min-w-0 truncate">{sender?.name ?? ''}</span>
							{held && <span className="shrink-0 text-warning">{held}</span>}
						</span>
					</button>
					<MarkReadButton onMarkRead={onMarkRead} />
					<RelativeTime
						date={item.latest_activity_at}
						compact
						compactDayLimit={7}
						className="shrink-0 font-mono text-[10px] font-medium uppercase tabular-nums text-muted-foreground"
					/>
				</div>
			</CardShell>
		)
	}

	return (
		<CardShell expanded>
			<div className="group/card flex flex-col gap-3 px-5 pb-[18px] pt-[17px]">
				<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5 border-b border-muted pb-[11px]">
					<span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
						{object?.type && (
							<TypeBadge
								type={object.type}
								variant="mono"
								className="text-[8px] font-bold tracking-[0.08em]"
							/>
						)}{' '}
						<Link
							to="/$workspaceId/objects/$objectId"
							params={{ workspaceId, objectId }}
							className="border-b border-border font-bold text-muted-foreground hover:border-foreground hover:text-foreground"
						>
							{objectTitle || 'Open'}
							<ArrowUpRight size={10} className="ml-0.5 inline" aria-hidden />
						</Link>
						{sender?.name ? ` · from ${sender.name}` : ''}
					</span>
					<TimelineHistory workspaceId={workspaceId} objectId={objectId} item={item} />
					{waiting ? (
						<span className="shrink-0 text-[11px] font-medium text-status-clustered-text">
							Waiting on {who}
						</span>
					) : (
						status && <StatusBadge status={status} variant="word" className="text-[11px]" />
					)}
					<RelativeTime
						date={item.latest_activity_at}
						compact
						compactDayLimit={7}
						className="shrink-0 font-mono text-[10px] font-medium uppercase tabular-nums text-muted-foreground"
					/>
					<MarkReadButton onMarkRead={onMarkRead} />
					{onToggleExpanded && (
						<button
							type="button"
							aria-label="Collapse"
							onClick={onToggleExpanded}
							className="grid size-[22px] shrink-0 self-center place-items-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
						>
							<ChevronUp size={11} aria-hidden />
						</button>
					)}
				</div>

				{/* The headline is the object itself; in List view clicking it folds
				    the card back down, the way the mockup's hero does. */}
				<div
					className={cn(
						'text-[18px] font-bold leading-[1.32] tracking-[-0.015em] text-pretty text-foreground',
						onToggleExpanded && 'cursor-pointer',
					)}
					onClick={onToggleExpanded}
					onKeyDown={(event) => {
						if (!onToggleExpanded) return
						if (event.key !== 'Enter' && event.key !== ' ') return
						event.preventDefault()
						onToggleExpanded()
					}}
					role={onToggleExpanded ? 'button' : undefined}
					tabIndex={onToggleExpanded ? 0 : undefined}
				>
					{title}
				</div>
				{/* The body is the agent's own words. A decision splits into the
				    state of the world (summary) and the single call it cannot make
				    alone (ask), which carries more weight. Anything else renders
				    the comment as written. */}
				{decision ? (
					<div className="-mt-1 flex max-w-[58ch] flex-col gap-2">
						<p className="text-[13px] leading-[1.55] text-pretty text-muted-foreground">
							{decision.summary}
						</p>
						<p className="text-[13px] font-semibold leading-[1.5] text-pretty text-foreground">
							{decision.ask}
						</p>
					</div>
				) : (
					mentionBody && (
						// The whole comment, not a preview: the reader answers here, so
						// nothing about the ask lives behind a second click.
						<div className="-mt-1 max-w-[58ch] text-[13px] leading-[1.55] text-pretty text-muted-foreground">
							<MarkdownContent content={mentionBody} size="sm" mentionActors={actors} />
						</div>
					)
				)}

				{options.length > 0 && (
					<DecisionOptionGrid>
						{options.map((option) => (
							<DecisionOptionCard
								key={option.id}
								option={option}
								pending={pendingId === option.id}
								disabled={pendingId !== null}
								onChoose={() => chooseOption(option)}
							/>
						))}
					</DecisionOptionGrid>
				)}

				<CommentInput
					workspaceId={workspaceId}
					objectId={objectId}
					// The composer answers the comment that put this card in the feed,
					// so a typed reply threads under it exactly as a taken option does.
					parentEventId={item.latest_mention?.event_id}
					// TODO: restore `variant="bar"` and `placeholder` once the
					// Object detail split lands them on the v2 composer (branch
					// commit 9c126196). Until then the composer renders in its
					// stacked form with the default placeholder.
					mentionDropdownPlacement="above"
					onSubmitted={onReplied}
				/>
			</div>
		</CardShell>
	)
}

// The card's frame: its own border and radius, lifted a little more once it
// is open (mockup's `border` / `radius` / `shadow` switch).
function CardShell({ expanded, children }: { expanded: boolean; children: React.ReactNode }) {
	return (
		<div
			data-testid="foryou-feed-card"
			className={cn(
				'overflow-hidden rounded-xl border border-border bg-card',
				expanded ? 'shadow-md' : 'shadow-xs',
			)}
		>
			{children}
		</div>
	)
}

// The green strip a decided card collapses to (mockup's `isDone`), minus the
// mockup's Undo — the reply is posted the moment the option is taken and the
// comment API has no delete, so there is nothing honest to take back.
function DecisionReceipt({ decided, who }: { decided: DecidedOption; who?: string }) {
	return (
		<div
			data-testid="decision-receipt"
			className="flex items-center gap-2.5 bg-status-done-bg px-4 py-3"
		>
			<span className="grid size-[19px] shrink-0 place-items-center rounded-full bg-success text-background">
				<Check size={11} aria-hidden />
			</span>
			<div className="min-w-0 flex-1">
				<div className="truncate text-[12.5px] font-bold leading-[1.35] text-status-done-text">
					{decided.label}
				</div>
				<div className="mt-px truncate text-[10.5px] text-status-done-text/70">
					{who ? `Sent to ${who}` : 'Reply sent'}
				</div>
			</div>
		</div>
	)
}

// Reading a card out of the feed without answering it. The fixture-driven
// mockup has no per-card dismiss (its cards only leave once decided), but a
// real feed needs one — kept quiet on pointer devices, always reachable on
// touch, per the responsiveness rules.
function MarkReadButton({ onMarkRead }: { onMarkRead: () => void }) {
	return (
		<button
			type="button"
			aria-label="Mark as read"
			title="Mark as read"
			onClick={(event) => {
				event.stopPropagation()
				onMarkRead()
			}}
			className="grid size-[22px] shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground can-hover:opacity-0 can-hover:focus-visible:opacity-100 can-hover:group-hover/card:opacity-100"
		>
			<Check size={12} aria-hidden />
		</button>
	)
}

/**
 * "Show timeline history" — the thread behind the card, folded away by
 * default. The events query only runs once the reader opens it, so a feed of
 * expanded cards does not fan out one request per card.
 */
function TimelineHistory({
	workspaceId,
	objectId,
	item,
}: {
	workspaceId: string
	objectId: string
	item: UnreadItem
}) {
	// 0 = closed, 1 = the newest messages, 2 = the whole thread.
	const [stage, setStage] = useState<0 | 1 | 2>(0)
	const {
		data: events,
		isPending,
		isError,
		error,
		refetch,
	} = useEntityEvents(workspaceId, objectId, { enabled: stage > 0 })
	const { data: actors } = useActors(workspaceId)

	// `useEntityEvents` returns newest-first, which is the order the mockup's
	// history block reads in.
	const comments = useMemo(
		() => (events ?? []).filter((event) => event.action === 'commented'),
		[events],
	)
	const unreadWindow = Math.max(item.unread_count, 1)
	const shown = stage === 2 ? comments : comments.slice(0, unreadWindow)
	const remaining = comments.length - shown.length

	if (stage === 0) {
		return (
			<button
				type="button"
				onClick={() => setStage(1)}
				className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10.5px] font-semibold text-muted-foreground hover:text-foreground"
			>
				<ChevronDown size={8} aria-hidden className="text-muted-foreground" />
				Show timeline history
			</button>
		)
	}

	return (
		<div className="order-last w-full basis-full">
			<div className="flex flex-col gap-[9px] rounded-xl border border-muted bg-secondary/40 px-[13px] pb-2.5 pt-[11px]">
				<div className="flex items-center gap-2.5">
					<span className="eyebrow shrink-0">On this object</span>
					<div className="h-px flex-1 bg-muted" />
					<button
						type="button"
						onClick={() => setStage(0)}
						className="shrink-0 text-[10.5px] font-semibold text-muted-foreground hover:text-foreground"
					>
						Hide
					</button>
				</div>
				{/* A failed fetch must not read as an empty thread — "nothing has been
				    said here" is a claim about the object, not about the request. */}
				{isError ? (
					<QueryStateError
						title="Couldn't load the timeline"
						error={error instanceof Error ? error : new Error('Unknown error')}
						onRetry={() => refetch()}
					/>
				) : (
					shown.length === 0 && (
						<p className="text-[11.5px] text-muted-foreground">
							{isPending ? 'Loading…' : 'Nothing has been said here yet.'}
						</p>
					)
				)}
				{shown.map((event) => (
					<TimelineMessage key={event.id} event={event} actors={actors} />
				))}
				{remaining > 0 && (
					<button
						type="button"
						onClick={() => setStage(2)}
						className="self-start whitespace-nowrap text-[10.5px] font-bold text-muted-foreground hover:text-foreground"
					>
						↓ {remaining} earlier {remaining === 1 ? 'message' : 'messages'}
					</button>
				)}
			</div>
		</div>
	)
}

function TimelineMessage({
	event,
	actors,
}: {
	event: EventResponse
	actors: ActorListItem[] | undefined
}) {
	const author = actors?.find((actor) => actor.id === event.actorId)
	const content = typeof event.data?.content === 'string' ? event.data.content : ''
	return (
		<div className="flex gap-2">
			<ActorAvatar
				id={event.actorId ?? undefined}
				name={author?.name ?? 'Unknown'}
				type={author?.type ?? 'agent'}
				size="sm"
				className="mt-px size-[19px] shrink-0 text-[8px]"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-[7px]">
					<span className="text-[11px] font-bold text-foreground">{author?.name ?? 'Unknown'}</span>
					<RelativeTime
						date={event.createdAt}
						compact
						compactDayLimit={7}
						className="font-mono text-[9.5px] font-medium uppercase tabular-nums text-muted-foreground"
					/>
				</div>
				<div className="mt-px line-clamp-3 text-[12px] leading-[1.5] text-pretty text-muted-foreground">
					<MarkdownContent content={content} size="xs" mentionActors={actors} />
				</div>
			</div>
		</div>
	)
}
