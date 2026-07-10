import { Chat, type ChatHandle } from '@/components/chat/chat'
import { ChatSidebarProvider } from '@/components/chat/chat-sidebar-provider'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sidebar, SidebarContent, SidebarHeader } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
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
import { Copy, Download, MoreHorizontal, Pin, PinOff, Plus, X } from 'lucide-react'
import { type PointerEvent, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'

const AGENT_NAME = 'Workspace Coach'

interface ChatPanelProps {
	workspaceId: string
	agentActorId: string | null
}

/**
 * Right-side chat surface. Wraps `<Chat surface="sheet" />` in a
 * shadcn `<Sidebar>` inside a local provider that never reserves horizontal
 * space in the main page layout (so the panel floats as an overlay by
 * default). When the user clicks the pin button, the route layout applies a
 * matching right margin to the main content so the panel pushes content
 * aside like a traditional sidebar.
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

	const handleNewChat = useCallback(() => {
		chatRef.current?.newChat()
	}, [])

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

	// In overlay mode (unpinned), close on outside click — matches the prior
	// Sheet behaviour. When pinned, the chat panel is docked and should survive clicks
	// in the reflowed main content. The picker popovers and tooltips render in
	// portals rooted at document.body; treat anything inside [data-radix-popper-content-wrapper]
	// or other Radix portal containers as "inside" so opening a picker doesn't
	// close the panel.
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
					// On narrow viewports the configured width can exceed the
					// screen — clamp to 100vw so the panel never hangs off the
					// right edge.
					'--sidebar-width': `min(${panelWidth}px, 100vw)`,
				} as React.CSSProperties
			}
		>
			<Sidebar
				ref={panelRef}
				side="right"
				collapsible="offcanvas"
				// `!flex` overrides the primitive's `hidden md:flex` so the
				// inner fixed panel renders on mobile too. The outer
				// `hidden md:block` wrapper is already forced visible by the
				// ChatSidebarProvider via `[&_[data-side=right]]:!block`.
				className="pointer-events-auto !flex"
			>
				<ResizeHandle
					width={panelWidth}
					onWidthChange={setPanelWidth}
					visible={open && !isMobile}
				/>
				<SidebarHeader className="flex-row items-center justify-between gap-2 border-b border-border px-3 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
					<div className="flex items-center gap-1">
						<h2 className="font-semibold text-base">Chat</h2>
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
					</div>
					<div className="flex items-center gap-1">
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
							aria-label="Close chat"
						>
							<X size={15} />
						</Button>
					</div>
				</SidebarHeader>
				<SidebarContent className="min-h-0 flex-1 p-3">
					<Chat
						ref={chatRef}
						workspaceId={workspaceId}
						agentActorId={agentActorId}
						surface="sheet"
						selection={selection}
						onDispatchSelection={dispatch}
						autoSendMessage={pendingMessage}
						onAutoSendConsumed={clearPendingMessage}
						onEventsChange={setEvents}
					/>
				</SidebarContent>
			</Sidebar>
		</ChatSidebarProvider>
	)
}

/**
 * Thin vertical hit-target on the left edge of the chat panel. Captures
 * pointer events and reports the live drag width back via `onWidthChange` —
 * the panel container re-renders immediately so the drag feels responsive.
 * Clamping to [min, max] happens inside the chat context setter so the
 * user can't drag the panel off-screen or down to zero.
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
			// Sidebar lives on the right edge, so dragging left should grow it.
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
