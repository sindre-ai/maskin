import { MessageActivity } from '@/components/chat/message-activity'
import { MessageBubble } from '@/components/chat/message-bubble'
import { MessageDivider } from '@/components/chat/message-divider'
import { ThreadComposer } from '@/components/chat/thread-composer'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
	useMarkThreadRead,
	useReplyThreads,
	useThreadReplies,
} from '@/hooks/use-conversation'
import { useConversationActivity } from '@/hooks/use-conversation-activity'
import { useIsDesktopViewport } from '@/hooks/use-mobile'
import { ApiError } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { defaultReplyRecipient } from '@/lib/message-threads'
import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

interface MessageThreadPaneProps {
	workspaceId: string
	conversationId: string
	rootId: number
	onClose: () => void
	className?: string
}

/**
 * The reply thread under one top-level message: the root, its replies oldest
 * first, and a composer that posts under it. The chat route renders it with
 * `key={rootId}`, so scroll, the "also send to chat" box and the draft reset
 * when a different root opens.
 */
export function MessageThreadPane({
	workspaceId,
	conversationId,
	rootId,
	onClose,
	className,
}: MessageThreadPaneProps) {
	const self = getStoredActor()
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const main = useConversationMessages(conversationId, workspaceId)
	const mainMessages = useMemo(() => flattenMessagesOldestFirst(main.data), [main.data])
	const mainRoot = mainMessages.find((m) => m.id === rootId)
	// A root older than the loaded main pages comes from the thread list instead.
	const replyThreads = useReplyThreads(workspaceId, { enabled: !mainRoot && !main.isLoading })
	const listed = replyThreads.data?.threads.find(
		(t) => t.root.id === rootId && t.conversationId === conversationId,
	)
	const root = mainRoot ?? listed?.root
	const summary = mainRoot?.thread ?? listed?.thread ?? null

	const replies = useThreadReplies(conversationId, workspaceId, rootId)
	const replyMessages = useMemo(() => flattenMessagesOldestFirst(replies.data), [replies.data])

	// Activity pairs reply messages to turns 1:1 in order, so it gets everything we hold.
	const everything = useMemo(() => {
		const byId = new Map(mainMessages.map((m) => [m.id, m]))
		for (const m of replyMessages) byId.set(m.id, m)
		return [...byId.values()].sort((a, b) => a.id - b.id)
	}, [mainMessages, replyMessages])
	const { byReplyMessageId, byTriggerMessageId } = useConversationActivity(
		workspaceId,
		conversationId,
		everything,
	)

	const markRead = useMarkThreadRead(conversationId, workspaceId)
	const markReadMutate = markRead.mutate
	const lastMarkedRef = useRef(0)
	const newestConfirmedId = replyMessages.reduce((max, m) => (m.id > max ? m.id : max), 0)
	// Only while the pane is open: a reply that lands with the pane closed is not read.
	useEffect(() => {
		if (newestConfirmedId <= lastMarkedRef.current) return
		lastMarkedRef.current = newestConfirmedId
		markReadMutate({ rootId, lastReadMessageId: newestConfirmedId })
	}, [newestConfirmedId, rootId, markReadMutate])

	// The summary counts every reply; the loaded pages only the ones fetched so far.
	const totalReplies = Math.max(summary?.replyCount ?? 0, replyMessages.length)

	const [alsoInChannel, setAlsoInChannel] = useState(false)
	const recipient = useMemo(
		() =>
			root
				? defaultReplyRecipient(
						root,
						[...(summary?.participants ?? []), ...(conversation?.participants ?? [])],
						self?.id,
					)
				: null,
		[root, summary?.participants, conversation?.participants, self?.id],
	)

	const reply = useMemo(
		() => ({ rootId, recipient, alsoInChannel, onSent: () => setAlsoInChannel(false) }),
		[rootId, recipient, alsoInChannel],
	)

	const paneRef = useRef<HTMLDivElement | null>(null)
	const scrollerRef = useRef<HTMLDivElement | null>(null)
	const bottomRef = useRef<HTMLDivElement | null>(null)
	const nearBottomRef = useRef(true)
	const replyCount = replyMessages.length
	const lastReplyCountRef = useRef(0)
	useEffect(() => {
		const grew = replyCount > lastReplyCountRef.current
		lastReplyCountRef.current = replyCount
		if (grew && nearBottomRef.current) bottomRef.current?.scrollIntoView({ block: 'end' })
	}, [replyCount])

	const isDesktop = useIsDesktopViewport()
	const rootReady = !!root
	// Focus the reply box when the thread opens, on desktop only: on a phone or tablet it would raise
	// the keyboard over the sheet for someone who just wants to read.
	// biome-ignore lint/correctness/useExhaustiveDependencies: rootReady only decides when the composer exists; it is not read inside.
	useEffect(() => {
		if (!isDesktop) return
		const frame = requestAnimationFrame(() => paneRef.current?.querySelector('textarea')?.focus())
		return () => cancelAnimationFrame(frame)
	}, [rootReady, isDesktop])

	const handleScroll = () => {
		const el = scrollerRef.current
		if (!el) return
		nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
	}

	const resolving = !root && (main.isLoading || replyThreads.isLoading)
	const notFound = !root || (markRead.error instanceof ApiError && markRead.error.status === 404)

	return (
		<div
			ref={paneRef}
			aria-label="Thread"
			onKeyDown={(e) => {
				if (e.key === 'Escape' && !e.defaultPrevented) onClose()
			}}
			className={cn('flex h-full min-h-0 w-full flex-col bg-surface-sunken', className)}
		>
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
				<h2 className="text-sm font-semibold text-foreground">Thread</h2>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="h-6 w-6"
					onClick={onClose}
					aria-label="Close thread"
				>
					<X size={14} />
				</Button>
			</div>
			{resolving ? (
				<div className="flex flex-1 items-center justify-center">
					<Spinner />
				</div>
			) : notFound || !root ? (
				<EmptyState
					className="flex-1"
					title="This thread couldn't be found"
					description="The message may have been removed, or it is not in this chat."
					action={
						<Button variant="link" size="sm" onClick={onClose}>
							Close
						</Button>
					}
				/>
			) : (
				<>
					<div
						ref={scrollerRef}
						onScroll={handleScroll}
						className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-4 pb-2"
					>
						<MessageBubble
							workspaceId={workspaceId}
							message={root}
							activity={(byReplyMessageId.get(root.id) ?? []).map((turn, i) => (
								<MessageActivity
									key={`${turn.sessionId}-above-${i}`}
									workspaceId={workspaceId}
									turn={turn}
									layout="inline"
								/>
							))}
						/>
						<MessageDivider
							label={
								totalReplies === 0
									? 'No replies yet'
									: `${totalReplies} ${totalReplies === 1 ? 'reply' : 'replies'}`
							}
						/>
						{replies.hasNextPage ? (
							<div className="flex justify-center">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => replies.fetchNextPage()}
									disabled={replies.isFetchingNextPage}
								>
									{replies.isFetchingNextPage ? <Spinner /> : 'Load earlier replies'}
								</Button>
							</div>
						) : null}
						{replies.isLoading ? (
							<div className="flex justify-center">
								<Spinner />
							</div>
						) : null}
						{replyMessages.map((reply) => (
							<div key={reply.id} data-message-id={reply.id} className="flex flex-col gap-1">
								<MessageBubble
									workspaceId={workspaceId}
									message={reply}
									activity={(byReplyMessageId.get(reply.id) ?? []).map((turn, i) => (
										<MessageActivity
											key={`${turn.sessionId}-above-${i}`}
											workspaceId={workspaceId}
											turn={turn}
											layout="inline"
										/>
									))}
								/>
								{(byTriggerMessageId.get(reply.id) ?? []).map((turn, i) => (
									<MessageActivity
										key={`${turn.sessionId}-below-${i}`}
										workspaceId={workspaceId}
										turn={turn}
									/>
								))}
							</div>
						))}
						<div ref={bottomRef} />
					</div>
					<div className="flex shrink-0 flex-col gap-2 px-4 pt-2 pb-3.5">
						<div className="flex items-center gap-2">
							<Checkbox
								id={`also-in-channel-${rootId}`}
								checked={alsoInChannel}
								onCheckedChange={(checked) => setAlsoInChannel(checked === true)}
							/>
							<Label
								htmlFor={`also-in-channel-${rootId}`}
								className="text-xs text-muted-foreground"
							>
								Also send to chat
							</Label>
						</div>
						<ThreadComposer
							workspaceId={workspaceId}
							conversationId={conversationId}
							reply={reply}
						/>
					</div>
				</>
			)}
		</div>
	)
}
