import { Chat, type ChatHandle } from '@/components/chat/chat'
import { ChatSidebarProvider } from '@/components/chat/chat-sidebar-provider'
import { ConversationRow } from '@/components/chat/conversation-row'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sidebar, SidebarContent, SidebarHeader } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
	useConversations,
	useCreateConversation,
	useMarkConversationRead,
	useUpdateConversationTitle,
} from '@/hooks/use-conversations'
import { useIsMobile } from '@/hooks/use-mobile'
import type { ConversationResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { type ChatAttachment, useChat } from '@/lib/chat-context'
import {
	buildChatExportFilename,
	downloadChatMarkdown,
	formatChatMarkdown,
} from '@/lib/chat-export'
import {
	type ChatSelectionAgent,
	type ChatSelectionNotification,
	type ChatSelectionObject,
	EMPTY_CHAT_SELECTION,
	chatSelectionReducer,
} from '@/lib/chat-selection'
import type { ChatEvent } from '@/lib/chat-stream'
import { ChevronLeft, Copy, Download, MoreHorizontal, Pin, PinOff, Plus, X } from 'lucide-react'
import { type PointerEvent, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'

const AGENT_NAME = 'Workspace Coach'

interface ChatPanelProps {
	workspaceId: string
	agentActorId: string | null
}

/**
 * Right-side panel that is conversation-first. When no conversation is
 * active it shows the conversation list (Recent DMs + Rooms). Selecting a row
 * opens the chat scoped to that conversation, which pre-loads historical
 * messages and links new sessions to the same conversation so every turn is
 * persisted.
 */
export function ChatPanel({ workspaceId, agentActorId }: ChatPanelProps) {
	const {
		open,
		setOpen,
		pendingAttachments,
		clearPendingAttachments,
		pendingMessage,
		clearPendingMessage,
		pinned,
		setPinned,
		panelWidth,
		setPanelWidth,
	} = useChat()
	const [selection, dispatch] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const panelRef = useRef<HTMLDivElement | null>(null)
	const chatRef = useRef<ChatHandle | null>(null)
	const [events, setEvents] = useState<ChatEvent[]>([])
	const isMobile = useIsMobile()

	const [activeConversation, setActiveConversation] = useState<ConversationResponse | null>(null)

	const { data: conversations = [], isLoading } = useConversations(workspaceId)
	const createConversation = useCreateConversation(workspaceId)
	const markRead = useMarkConversationRead(workspaceId)
	const updateTitle = useUpdateConversationTitle(workspaceId)

	const [editingTitle, setEditingTitle] = useState(false)
	const [titleDraft, setTitleDraft] = useState('')
	const titleInputRef = useRef<HTMLInputElement | null>(null)
	const [pendingAutoMessage, setPendingAutoMessage] = useState<string | null>(null)

	const dms = conversations.filter((c) => c.type === 'dm')
	const rooms = conversations.filter((c) => c.type === 'room')
	const isEmpty = !isLoading && conversations.length === 0

	// Reset to list view when the panel closes.
	useEffect(() => {
		if (!open) setActiveConversation(null)
	}, [open])

	const handleSelectConversation = useCallback(
		(c: ConversationResponse) => {
			markRead.mutate(c.id)
			setActiveConversation(c)
			setEditingTitle(false)
		},
		[markRead],
	)

	const handleNewConversation = useCallback(() => {
		const actor = getStoredActor()
		if (!actor) {
			toast.error('Not signed in — please reload and try again')
			return
		}
		if (!agentActorId) {
			toast.error('Agent not ready yet — please try again in a moment')
			return
		}
		createConversation.mutate(
			{ type: 'dm', participant_actor_ids: [actor.id, agentActorId] },
			{ onSuccess: (c) => setActiveConversation(c) },
		)
	}, [createConversation, agentActorId])

	const handleNewConversationAndSend = useCallback(
		async (content: string) => {
			const actor = getStoredActor()
			if (!actor) {
				toast.error('Not signed in — please reload and try again')
				throw new Error('Not signed in')
			}
			if (!agentActorId) {
				toast.error('Agent not ready yet — please try again in a moment')
				throw new Error('Agent not ready')
			}
			const c = await createConversation.mutateAsync({
				type: 'dm',
				participant_actor_ids: [actor.id, agentActorId],
			})
			setActiveConversation(c)
			setPendingAutoMessage(content)
		},
		[createConversation, agentActorId],
	)

	const handleNewChat = useCallback(() => {
		chatRef.current?.newChat()
	}, [])

	const handleAutoSendConsumed = useCallback(() => {
		setPendingAutoMessage(null)
		clearPendingMessage()
	}, [clearPendingMessage])

	const handleTitleDoubleClick = useCallback(() => {
		if (!activeConversation) return
		setTitleDraft(activeConversation.title ?? '')
		setEditingTitle(true)
		setTimeout(() => titleInputRef.current?.select(), 0)
	}, [activeConversation])

	const handleTitleSave = useCallback(() => {
		if (!activeConversation) return
		setEditingTitle(false)
		const trimmed = titleDraft.trim() || null
		if (trimmed === (activeConversation.title ?? null)) return
		updateTitle.mutate(
			{ id: activeConversation.id, title: trimmed },
			{
				onSuccess: (updated) => setActiveConversation(updated),
			},
		)
	}, [activeConversation, titleDraft, updateTitle])

	const buildExportMarkdown = useCallback(() => {
		const actor = getStoredActor()
		return formatChatMarkdown(events, {
			workspaceId,
			frontendUrl: typeof window !== 'undefined' ? window.location.origin : 'https://maskin.io',
			userName: actor?.name?.trim() || 'You',
			agentName: AGENT_NAME,
		})
	}, [events, workspaceId])

	const handleCopy = useCallback(async () => {
		const md = buildExportMarkdown()
		try {
			await navigator.clipboard.writeText(md)
			toast.success('Conversation copied as markdown')
		} catch (err) {
			console.error('[chat] clipboard copy failed', err)
			toast.error('Could not copy — try Download instead')
		}
	}, [buildExportMarkdown])

	const handleDownload = useCallback(() => {
		const md = buildExportMarkdown()
		downloadChatMarkdown(md, buildChatExportFilename(AGENT_NAME))
	}, [buildExportMarkdown])

	useEffect(() => {
		if (pendingAttachments.length === 0) return
		for (const attachment of pendingAttachments) {
			const action = attachmentToAction(attachment)
			if (action) dispatch(action)
		}
		clearPendingAttachments()
	}, [pendingAttachments, clearPendingAttachments])

	useEffect(() => {
		if (!open || pinned) return
		function handleMouseDown(event: MouseEvent) {
			const target = event.target
			if (!(target instanceof Node)) return
			if (panelRef.current?.contains(target)) return
			if (target instanceof Element && target.closest('[data-radix-popper-content-wrapper]')) {
				return
			}
			setOpen(false)
		}
		document.addEventListener('mousedown', handleMouseDown)
		return () => document.removeEventListener('mousedown', handleMouseDown)
	}, [open, pinned, setOpen])

	return (
		<ChatSidebarProvider
			open={open}
			onOpenChange={setOpen}
			style={
				{
					'--sidebar-width': `min(${panelWidth}px, 100vw)`,
				} as React.CSSProperties
			}
		>
			<Sidebar
				ref={panelRef}
				side="right"
				collapsible="offcanvas"
				className="pointer-events-auto !flex"
			>
				<ResizeHandle
					width={panelWidth}
					onWidthChange={setPanelWidth}
					visible={open && !isMobile}
				/>
				<SidebarHeader className="flex-row items-center justify-between gap-2 border-b border-border px-3 py-2">
					{activeConversation ? (
						// Active conversation header: back | title | export menu | close
						<>
							<div className="flex items-center gap-1">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="h-7 w-7"
											onClick={() => setActiveConversation(null)}
											aria-label="Back to conversations"
										>
											<ChevronLeft size={15} />
										</Button>
									</TooltipTrigger>
									<TooltipContent>Back to conversations</TooltipContent>
								</Tooltip>
								{editingTitle ? (
									<input
										ref={titleInputRef}
										type="text"
										value={titleDraft}
										onChange={(e) => setTitleDraft(e.target.value)}
										onBlur={handleTitleSave}
										onKeyDown={(e) => {
											if (e.key === 'Enter') handleTitleSave()
											if (e.key === 'Escape') setEditingTitle(false)
										}}
										className="min-w-0 flex-1 truncate bg-transparent text-sm font-semibold outline-none"
										placeholder="Untitled"
										aria-label="Conversation title"
									/>
								) : (
									<span
										className="truncate text-sm font-semibold cursor-text"
										onDoubleClick={handleTitleDoubleClick}
										title="Double-click to rename"
									>
										{activeConversation.title || 'Untitled'}
									</span>
								)}
							</div>
							<div className="flex items-center gap-1">
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="h-7 w-7"
											aria-label="Conversation menu"
											disabled={events.length === 0}
										>
											<MoreHorizontal size={15} />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start" className="w-56">
										<DropdownMenuItem onSelect={() => void handleCopy()}>
											<Copy size={14} />
											Copy as markdown
										</DropdownMenuItem>
										<DropdownMenuItem onSelect={() => handleDownload()}>
											<Download size={14} />
											Download as markdown
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="h-7 w-7"
											onClick={handleNewChat}
											aria-label="New conversation"
										>
											<Plus size={15} />
										</Button>
									</TooltipTrigger>
									<TooltipContent>New conversation</TooltipContent>
								</Tooltip>
								{!isMobile && <PinToggle pinned={pinned} onToggle={() => setPinned(!pinned)} />}
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="h-7 w-7"
									onClick={() => setOpen(false)}
									aria-label="Close"
								>
									<X size={15} />
								</Button>
							</div>
						</>
					) : (
						// List view header: Conversations title | new | pin | close
						<>
							<h2 className="font-semibold text-base">Conversations</h2>
							<div className="flex items-center gap-1">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="h-7 w-7"
											onClick={handleNewConversation}
											disabled={createConversation.isPending}
											aria-label="New conversation"
										>
											<Plus size={15} />
										</Button>
									</TooltipTrigger>
									<TooltipContent>New conversation</TooltipContent>
								</Tooltip>
								{!isMobile && <PinToggle pinned={pinned} onToggle={() => setPinned(!pinned)} />}
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="h-7 w-7"
									onClick={() => setOpen(false)}
									aria-label="Close"
								>
									<X size={15} />
								</Button>
							</div>
						</>
					)}
				</SidebarHeader>
				<SidebarContent className="min-h-0 flex-1 p-3">
					{activeConversation ? (
						<Chat
							ref={chatRef}
							workspaceId={workspaceId}
							agentActorId={agentActorId}
							conversationId={activeConversation.id}
							surface="sheet"
							selection={selection}
							onDispatchSelection={dispatch}
							autoSendMessage={pendingAutoMessage ?? pendingMessage}
							onAutoSendConsumed={handleAutoSendConsumed}
							onEventsChange={setEvents}
						/>
					) : (
						<div className="flex h-full flex-col gap-2">
							<ConversationList
								dms={dms}
								rooms={rooms}
								isEmpty={isEmpty}
								onSelect={handleSelectConversation}
							/>
							<div className="shrink-0">
								<Chat
									workspaceId={workspaceId}
									agentActorId={agentActorId}
									surface="pulse-bar"
									selection={selection}
									onDispatchSelection={dispatch}
									onSubmitOverride={handleNewConversationAndSend}
								/>
							</div>
						</div>
					)}
				</SidebarContent>
			</Sidebar>
		</ChatSidebarProvider>
	)
}

interface ConversationListProps {
	dms: ConversationResponse[]
	rooms: ConversationResponse[]
	isEmpty: boolean
	onSelect: (c: ConversationResponse) => void
}

function ConversationList({ dms, rooms, isEmpty, onSelect }: ConversationListProps) {
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			{isEmpty ? (
				<div className="flex h-full items-center justify-center">
					<EmptyState title="No conversations yet" description="Send a message to start one" />
				</div>
			) : (
				<div className="pb-1">
					{dms.length > 0 && (
						<>
							<SectionLabel>Recent</SectionLabel>
							{dms.map((c) => (
								<ConversationRow
									key={c.id}
									type="dm"
									title={c.title}
									preview={c.lastMessagePreview}
									timestamp={c.lastActivityAt ?? c.createdAt}
									unread={c.unreadCount > 0}
									participants={c.participants.map((p) => ({
										name: p.name,
										type: p.type,
										online: p.isOnline,
									}))}
									onClick={() => onSelect(c)}
								/>
							))}
						</>
					)}
					{rooms.length > 0 && (
						<>
							<SectionLabel>Rooms</SectionLabel>
							{rooms.map((c) => (
								<ConversationRow
									key={c.id}
									type="room"
									title={c.title}
									preview={c.lastMessagePreview}
									timestamp={c.lastActivityAt ?? c.createdAt}
									unread={c.unreadCount > 0}
									participants={c.participants.map((p) => ({
										name: p.name,
										type: p.type,
										online: p.isOnline,
									}))}
									onClick={() => onSelect(c)}
								/>
							))}
						</>
					)}
				</div>
			)}
		</div>
	)
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<p className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
			{children}
		</p>
	)
}

/**
 * Thin vertical hit-target on the left edge of the chat panel.
 */
function ResizeHandle({
	width,
	onWidthChange,
	visible,
}: {
	width: number
	onWidthChange: (next: number) => void
	visible: boolean
}) {
	const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null)

	const handlePointerDown = useCallback(
		(event: PointerEvent<HTMLButtonElement>) => {
			event.preventDefault()
			event.currentTarget.setPointerCapture(event.pointerId)
			dragStartRef.current = { startX: event.clientX, startWidth: width }
			document.body.style.cursor = 'ew-resize'
			document.body.style.userSelect = 'none'
		},
		[width],
	)

	const handlePointerMove = useCallback(
		(event: PointerEvent<HTMLButtonElement>) => {
			const drag = dragStartRef.current
			if (!drag) return
			const delta = drag.startX - event.clientX
			onWidthChange(drag.startWidth + delta)
		},
		[onWidthChange],
	)

	const endDrag = useCallback((event: PointerEvent<HTMLButtonElement>) => {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId)
		}
		dragStartRef.current = null
		document.body.style.cursor = ''
		document.body.style.userSelect = ''
	}, [])

	if (!visible) return null
	return (
		<button
			type="button"
			aria-label="Resize chat panel"
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			className="absolute inset-y-0 left-0 z-20 w-1 -translate-x-1/2 cursor-ew-resize bg-transparent transition-colors hover:bg-border"
		/>
	)
}

function PinToggle({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
	const label = pinned ? 'Unpin sidebar' : 'Pin sidebar'
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="h-7 w-7"
					onClick={onToggle}
					aria-label={label}
					aria-pressed={pinned}
				>
					{pinned ? <PinOff size={15} /> : <Pin size={15} />}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}

function attachmentToAction(attachment: ChatAttachment) {
	if (attachment.kind === 'agent') {
		const agent: ChatSelectionAgent = {
			id: attachment.id,
			name: attachment.name ?? null,
		}
		return { type: 'add_agent' as const, agent }
	}
	if (attachment.kind === 'object') {
		const object: ChatSelectionObject = {
			id: attachment.id,
			title: attachment.title ?? null,
			type: attachment.type ?? null,
		}
		return { type: 'add_object' as const, object }
	}
	if (attachment.kind === 'notification') {
		const notification: ChatSelectionNotification = {
			id: attachment.id,
			title: attachment.title ?? null,
		}
		return { type: 'add_notification' as const, notification }
	}
	return null
}
