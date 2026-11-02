import { Composer } from '@/components/chat/chat'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { useDefaultChatAgent } from '@/hooks/use-actors'
import { type BriefingCard, useBriefings } from '@/hooks/use-briefings'
import { useCreateConversation } from '@/hooks/use-conversations'
import {
	BRIEFING_FORMAT_LABEL,
	briefingChatAttachments,
	isBriefingSeen,
	markBriefingSeen,
	orderBriefingRow,
	pickBriefingChatAgent,
	seenBriefingStamps,
	tellMeMoreMessage,
} from '@/lib/briefing-stories'
import {
	type ChatSelectionFile,
	EMPTY_CHAT_SELECTION,
	buildOneShotActionPrompt,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { prepareMiniAppHtml } from '@/lib/mini-app'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowUpRight, ChevronLeft, ChevronRight, Loader2, MessageSquare } from 'lucide-react'
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
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
			className="flex h-31 w-60 shrink-0 snap-start flex-col rounded-xl border border-border bg-card p-3 text-left shadow-xs transition-colors duration-150 hover:border-border-strong hover:bg-brand-subtle"
		>
			<span className="flex items-center gap-2">
				<span className="eyebrow truncate">{BRIEFING_FORMAT_LABEL}</span>
				{!seen && (
					<span aria-hidden="true" className="ml-auto size-1.5 shrink-0 rounded-full bg-brand" />
				)}
			</span>
			<span
				className={cn(
					'mt-1.5 line-clamp-2 text-[19px] font-bold leading-[1.2] tracking-[-0.02em] text-pretty',
					seen ? 'text-muted-foreground' : 'text-foreground',
				)}
			>
				{card.headline}
			</span>
			<span className="mt-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
				<ActorAvatar name={card.author.name} type={card.author.type} size="sm" />
				<span className="min-w-0 truncate">
					{card.author.name} · <RelativeTime date={card.updatedAt} />
				</span>
			</span>
		</button>
	)
}

/**
 * The page behind a card, in a wide two-pane viewer: the page on the left (a segment per
 * briefing along its top, Previous / Next under it) and a conversation panel on the right
 * ("Talk to <agent>": the chat composer plus a Tell me more chip). Below `md` it is a full
 * page with the conversation under the page. Arrow keys and J / K move between briefings
 * unless a field has the focus.
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
	const [selection, dispatchSelection] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const [sendError, setSendError] = useState<string | null>(null)

	// A person tagged in the composer overrides the recipient, like the brief drawer does.
	const firstMentionId = selection.agents[0] ?? null
	const agent = firstMentionId
		? { id: firstMentionId, name: selection.agentNames[firstMentionId] ?? '' }
		: card
			? pickBriefingChatAgent(card.author, defaultAgent)
			: null

	// Starts the chat for the reader and sends the message: the press is the ask. The page goes
	// along as a real attachment, so the agent opens the briefing itself rather than guessing
	// from the title.
	const startChat = async (
		content: string,
		files: Array<{ fileId: string; name: string; mimeType?: string; sizeBytes?: number }> = [],
		initialMessage: string = content,
	) => {
		if (!card || createConversation.isPending) return
		if (!agent) {
			toast.error('There is no agent to ask yet.')
			throw new Error('No agent available to start a chat')
		}
		const conversation = await createConversation.mutateAsync({
			title: card.headline,
			participant_actor_ids: [agent.id],
			initial_message: initialMessage,
			initial_message_metadata: { attachments: briefingChatAttachments(card, files) },
		})
		onClose()
		navigate({
			to: '/$workspaceId/chats/$conversationId',
			params: { workspaceId, conversationId: conversation.id },
		})
	}

	const tellMeMore = async () => {
		if (!card) return
		try {
			await startChat(tellMeMoreMessage(card.headline))
		} catch {
			toast.error("Couldn't start the chat — try again.")
		}
	}

	const onSend = async (content: string, extras?: { files: ChatSelectionFile[] }) => {
		setSendError(null)
		const files = [...selection.files, ...(extras?.files ?? [])]
		const hasContext = selection.objects.length > 0 || selection.notifications.length > 0
		try {
			await startChat(
				content,
				files,
				hasContext
					? buildOneShotActionPrompt(content, selection.objects, selection.notifications)
					: content,
			)
			dispatchSelection({ type: 'clear_all' })
		} catch (error) {
			setSendError(error instanceof Error ? error.message : "Couldn't start the chat — try again.")
			throw error
		}
	}

	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (event.metaKey || event.ctrlKey || event.altKey) return
			// Typing in the conversation box must not turn the page.
			const target = event.target
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
			) {
				return
			}
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

	const agentName = agent?.name || 'the agent'

	return (
		<ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
			<ResponsiveDialogContent
				data-testid="briefing-viewer"
				overlayClassName="bg-black/50"
				className="flex h-dvh max-h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 md:h-[88dvh] md:max-h-[88dvh] md:w-[calc(100%-2rem)] md:max-w-6xl md:flex-row md:rounded-2xl md:border md:shadow-xl"
			>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
						<div className="flex items-center gap-2.5 pr-12 md:pr-0">
							<ActorAvatar name={card.author.name} type={card.author.type} size="md" />
							<div className="min-w-0 flex-1">
								<ResponsiveDialogTitle className="truncate text-sm font-semibold">
									{card.headline}
								</ResponsiveDialogTitle>
								<ResponsiveDialogDescription className="truncate text-xs">
									{card.author.name} · <RelativeTime date={card.updatedAt} />
								</ResponsiveDialogDescription>
							</div>
						</div>
					</div>
					{/* The page fills the whole pane, so a list under a headline gets the full column. */}
					<iframe
						key={card.id}
						title={card.headline}
						srcDoc={srcDoc}
						sandbox="allow-scripts"
						className="block min-h-0 w-full flex-1 bg-background"
					/>
					<div className="flex items-center gap-2 p-3">
						<Button
							type="button"
							variant="secondary"
							size="icon"
							className="shrink-0 rounded-full"
							aria-label="Previous briefing"
							disabled={!hasPrevious}
							onClick={() => onIndexChange(index - 1)}
						>
							<ChevronLeft aria-hidden />
						</Button>
						<span className="min-w-0 flex-1 text-center text-xs text-muted-foreground">
							{cards.length > 1 ? `${index + 1} of ${cards.length}` : null}
						</span>
						<Button
							type="button"
							variant="secondary"
							size="icon"
							className="shrink-0 rounded-full"
							aria-label="Next briefing"
							disabled={!hasNext}
							onClick={() => onIndexChange(index + 1)}
						>
							<ChevronRight aria-hidden />
						</Button>
						<Button asChild variant="secondary" size="icon" className="shrink-0 rounded-full">
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

				<aside
					aria-label="Conversation"
					className="flex shrink-0 flex-col border-t border-border bg-card md:w-72 md:border-l md:border-t-0 lg:w-96"
				>
					<div className="hidden flex-col gap-1 px-4 pb-3 pr-14 pt-4 md:flex">
						<h3 className="text-sm font-semibold">Talk to {agentName}</h3>
						<p className="text-xs text-muted-foreground">
							Ask a question about this briefing, or tell {agentName} to go ahead with what it
							proposes.
						</p>
					</div>
					<div className="mt-auto flex flex-col gap-3 p-3">
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								className="rounded-full"
								onClick={tellMeMore}
								disabled={createConversation.isPending}
							>
								{createConversation.isPending ? (
									<Loader2 aria-hidden className="animate-spin" />
								) : (
									<MessageSquare aria-hidden />
								)}{' '}
								Tell me more
							</Button>
						</div>
						<Composer
							workspaceId={workspaceId}
							onSend={onSend}
							longTextAsFile
							disabled={false}
							pending={createConversation.isPending}
							surface="pulse-bar"
							placeholder={`Message ${agentName}…`}
							textareaLabel="Talk about this briefing"
							selection={selection}
							onDispatchSelection={dispatchSelection}
							onRemoveAgent={(id) => dispatchSelection({ type: 'remove_agent', id })}
							onRemoveObject={(id) => dispatchSelection({ type: 'remove_object', id })}
							onRemoveNotification={(id) => dispatchSelection({ type: 'remove_notification', id })}
							onRemoveFile={(fileId) => dispatchSelection({ type: 'remove_file', fileId })}
							externalError={sendError}
							onDismissExternalError={() => setSendError(null)}
						/>
					</div>
				</aside>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
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

	const unreadCount = row.filter((card) => !isBriefingSeen(card, seen)).length

	return (
		<section aria-label="Briefings" data-testid="briefing-row" className="mt-3">
			<h2 className="mb-2 flex items-baseline gap-2 text-xs font-semibold text-foreground">
				Briefings
				{unreadCount > 0 && (
					<span className="font-normal text-muted-foreground">{unreadCount} unread</span>
				)}
			</h2>
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
