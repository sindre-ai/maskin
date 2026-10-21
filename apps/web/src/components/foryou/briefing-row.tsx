import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useDefaultChatAgent } from '@/hooks/use-actors'
import { type BriefingCard, useBriefings } from '@/hooks/use-briefings'
import { useCreateConversation } from '@/hooks/use-conversations'
import {
	BRIEFING_FORMAT_LABEL,
	isBriefingSeen,
	markBriefingSeen,
	orderBriefingRow,
	seenBriefingStamps,
} from '@/lib/briefing-stories'
import { cn } from '@/lib/cn'
import { prepareMiniAppHtml } from '@/lib/mini-app'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowUpRight, ChevronLeft, ChevronRight, Loader2, MessageSquare } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

function BriefingTile({
	card,
	seen,
	onOpen,
}: {
	card: BriefingCard
	seen: boolean
	onOpen: () => void
}) {
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`${card.author.name}: ${card.headline}${seen ? '' : ', new'}`}
			data-testid="briefing-card"
			data-seen={seen}
			className={cn(
				'flex h-44 w-32 shrink-0 snap-start flex-col rounded-2xl p-3 text-left shadow-xs transition-colors duration-150',
				seen
					? 'border border-border bg-card hover:border-border-strong'
					: 'border-2 border-brand bg-card hover:bg-muted/40',
			)}
		>
			<span className="flex items-center gap-1.5">
				<ActorAvatar name={card.author.name} type={card.author.type} size="sm" />
				<span
					className={cn(
						'min-w-0 truncate text-xs font-semibold',
						seen ? 'text-muted-foreground' : 'text-foreground',
					)}
				>
					{card.author.name}
				</span>
			</span>
			<span
				className={cn(
					'mt-auto line-clamp-4 text-[15px] font-bold leading-[1.25] tracking-[-0.015em] text-pretty',
					seen ? 'text-muted-foreground' : 'text-foreground',
				)}
			>
				{card.headline}
			</span>
			<span className="eyebrow mt-2 truncate">{BRIEFING_FORMAT_LABEL}</span>
		</button>
	)
}

/**
 * The page behind a card, played the way a short is: one tall portrait frame
 * centred on a lighter scrim, a segment per briefing along its top, and a button
 * on each side to move between briefings (over the frame's edges on a phone). Arrow
 * keys and J / K move too. Under the frame, "Tell me more" starts a chat about the
 * page and "Open page" opens it full size. Below `md` the frame fills the screen.
 *
 * The HTML is agent-written, so it renders the same way every other HTML file
 * does: in a sandboxed `srcdoc` frame with the platform CSP injected and no
 * `allow-same-origin`, which keeps it off our origin's cookies, storage and DOM.
 */
function BriefingViewer({
	workspaceId,
	cards,
	index,
	onIndexChange,
	onClose,
}: {
	workspaceId: string
	cards: BriefingCard[]
	index: number
	onIndexChange: (next: number) => void
	onClose: () => void
}) {
	const card = cards[index]
	const srcDoc = useMemo(() => (card?.html ? prepareMiniAppHtml(card.html) : ''), [card?.html])
	const hasPrevious = index > 0
	const hasNext = index < cards.length - 1
	const navigate = useNavigate()

	const createConversation = useCreateConversation(workspaceId)
	const defaultAgent = useDefaultChatAgent()

	// Starts the chat for the reader and sends the question: the button press is the ask. The
	// page goes along as a real attachment (a file chip in the chat, and the agent is handed its
	// file id), so it opens the briefing itself rather than guessing from the title. It goes to the agent that wrote the page, else the workspace's default one.
	const tellMeMore = async () => {
		if (!card || createConversation.isPending) return
		const agent =
			card.author.id && card.author.type === 'agent'
				? { id: card.author.id, name: card.author.name }
				: defaultAgent
		if (!agent) {
			toast.error('There is no agent to ask yet.')
			return
		}
		try {
			const conversation = await createConversation.mutateAsync({
				title: card.headline,
				participant_actor_ids: [agent.id],
				initial_message: `Tell me more about this briefing: "${card.headline}"`,
				initial_message_metadata: {
					attachments: [{ file_id: card.id, name: card.name, mime_type: 'text/html' }],
				},
			})
			onClose()
			navigate({
				to: '/$workspaceId/chats/$conversationId',
				params: { workspaceId, conversationId: conversation.id },
			})
		} catch {
			toast.error("Couldn't start the chat — try again.")
		}
	}

	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (event.metaKey || event.ctrlKey || event.altKey) return
			if (['ArrowDown', 'ArrowRight', 'j'].includes(event.key) && hasNext) {
				event.preventDefault()
				onIndexChange(index + 1)
			} else if (['ArrowUp', 'ArrowLeft', 'k'].includes(event.key) && hasPrevious) {
				event.preventDefault()
				onIndexChange(index - 1)
			}
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [index, hasNext, hasPrevious, onIndexChange])

	if (!card) return null

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				data-testid="briefing-viewer"
				overlayClassName="bg-black/50"
				onClick={(event) => {
					// The content layer covers the screen, so the scrim never receives the click.
					if (event.target === event.currentTarget) onClose()
				}}
				className="inset-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 items-center justify-center gap-0 border-0 bg-transparent p-0 shadow-none data-[state=closed]:slide-out-to-left-0 data-[state=closed]:slide-out-to-top-0 data-[state=open]:slide-in-from-left-0 data-[state=open]:slide-in-from-top-0 sm:rounded-none [&>button:last-child]:right-4 [&>button:last-child]:top-4 [&>button:last-child]:z-20 [&>button:last-child]:rounded-full [&>button:last-child]:bg-background [&>button:last-child]:p-2.5 [&>button:last-child]:opacity-100 [&>button:last-child]:shadow-md"
			>
				<div className="relative h-full w-full md:h-[92dvh] md:w-auto md:max-w-full md:aspect-[9/16]">
					<div className="flex h-full w-full flex-col overflow-hidden bg-background md:rounded-2xl md:shadow-xl">
						<div className="flex flex-col gap-3 px-4 pb-3 pt-4">
							<nav className="flex gap-1" aria-label="Briefings">
								{cards.map((entry, position) => (
									<button
										key={entry.id}
										type="button"
										aria-label={`Briefing ${position + 1}: ${entry.headline}`}
										aria-current={position === index}
										onClick={() => onIndexChange(position)}
										className="group flex-1 py-1"
									>
										<span
											className={cn(
												'block h-[3px] rounded-full transition-colors duration-150',
												position <= index
													? 'bg-foreground'
													: 'bg-border group-hover:bg-border-strong',
											)}
										/>
									</button>
								))}
							</nav>
							<div className="flex items-center gap-2.5 pr-10">
								<ActorAvatar name={card.author.name} type={card.author.type} size="md" />
								<div className="min-w-0 flex-1">
									<DialogTitle className="truncate text-sm font-semibold">
										{card.headline}
									</DialogTitle>
									<DialogDescription className="truncate text-xs">
										{card.author.name} · <RelativeTime date={card.updatedAt} />
										{cards.length > 1 && ` · ${index + 1} of ${cards.length}`}
									</DialogDescription>
								</div>
							</div>
						</div>
						<iframe
							key={card.id}
							title={card.headline}
							srcDoc={srcDoc}
							sandbox="allow-scripts"
							className="block min-h-0 w-full flex-1 bg-background"
						/>

						<div className="flex items-center gap-2 border-t border-border p-3">
							<Button
								type="button"
								variant="secondary"
								className="flex-1 justify-between"
								onClick={tellMeMore}
								disabled={createConversation.isPending}
							>
								<span className="flex items-center gap-2">
									{createConversation.isPending ? (
										<Loader2 aria-hidden className="animate-spin" />
									) : (
										<MessageSquare aria-hidden />
									)}{' '}
									Tell me more
								</span>
								<ChevronRight aria-hidden className="text-muted-foreground" />
							</Button>
							<Button asChild variant="secondary" size="icon" className="shrink-0">
								<Link
									to="/$workspaceId/files/$fileId"
									params={{ workspaceId, fileId: card.id }}
									aria-label="Open page"
									title="Open the page"
								>
									<ArrowUpRight aria-hidden />
								</Link>
							</Button>
						</div>
					</div>

					{cards.length > 1 && (
						<>
							<Button
								type="button"
								variant="secondary"
								className="absolute bottom-20 left-3 z-10 size-12 rounded-full p-0 shadow-md md:bottom-auto md:left-auto md:right-full md:top-1/2 md:mr-4 md:-translate-y-1/2"
								aria-label="Previous briefing"
								disabled={!hasPrevious}
								onClick={() => onIndexChange(index - 1)}
							>
								<ChevronLeft aria-hidden className="!size-5" />
							</Button>
							<Button
								type="button"
								variant="secondary"
								className="absolute bottom-20 right-3 z-10 size-12 rounded-full p-0 shadow-md md:bottom-auto md:left-full md:right-auto md:top-1/2 md:ml-4 md:-translate-y-1/2"
								aria-label="Next briefing"
								disabled={!hasNext}
								onClick={() => onIndexChange(index + 1)}
							>
								<ChevronRight aria-hidden className="!size-5" />
							</Button>
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
	)
}

/**
 * Briefings — the row of cards at the top of For you (the web twin of the iOS
 * story row). Unseen cards lead with a brand ring; opening one marks it seen and
 * moves it to the end of the row. A page edited after it was read is unseen again.
 * With no briefings the row draws nothing.
 *
 * The viewer pages through the cards in the order they were written (newest
 * first), not the row's seen/unseen order, so Next never jumps around as pages
 * are marked seen.
 */
export function BriefingRow({ workspaceId }: { workspaceId: string }) {
	const { cards } = useBriefings(workspaceId)
	const [seen, setSeen] = useState(() => seenBriefingStamps())
	const [openIndex, setOpenIndex] = useState<number | null>(null)

	const row = useMemo(() => orderBriefingRow(cards, seen), [cards, seen])

	const open = useCallback(
		(index: number) => {
			const card = cards[index]
			if (!card) return
			markBriefingSeen(card)
			setSeen(seenBriefingStamps())
			setOpenIndex(index)
		},
		[cards],
	)

	if (cards.length === 0) return null

	return (
		<section aria-label="Briefings" data-testid="briefing-row" className="mt-3">
			<div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
				{row.map((card) => (
					<BriefingTile
						key={card.id}
						card={card}
						seen={isBriefingSeen(card, seen)}
						onOpen={() => open(cards.findIndex((c) => c.id === card.id))}
					/>
				))}
			</div>
			{openIndex !== null && (
				<BriefingViewer
					workspaceId={workspaceId}
					cards={cards}
					index={openIndex}
					onIndexChange={open}
					onClose={() => setOpenIndex(null)}
				/>
			)}
		</section>
	)
}
