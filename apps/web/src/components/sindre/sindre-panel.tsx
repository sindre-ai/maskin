import { ConversationSwitcher } from '@/components/sindre/conversation-switcher'
import { ConversationView } from '@/components/sindre/conversation-view'
import { SindreSidebarProvider } from '@/components/sindre/sindre-sidebar-provider'
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
import { useSindreConversation } from '@/hooks/use-sindre-conversation'
import { conversationToMarkdown } from '@/lib/chat-store'
import { useSindre } from '@/lib/sindre-context'
import { buildSindreExportFilename, downloadSindreMarkdown } from '@/lib/sindre-export'
import { Copy, Download, MoreHorizontal, Pin, PinOff, Plus, X } from 'lucide-react'
import { type PointerEvent, useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'

interface SindrePanelProps {
	workspaceId: string
	sindreActorId: string | null
}

/**
 * Right-side Sindre surface. Hosts a standalone, multiplayer conversation
 * (the current user + one or more agents) via `useSindreConversation`, with a
 * conversation switcher in the header and the attributed transcript + composer
 * in the body. Wrapped in a shadcn `<Sidebar>` inside a local provider so it
 * floats as an overlay by default and docks (pushing content aside) when
 * pinned.
 */
export function SindrePanel({ workspaceId, sindreActorId }: SindrePanelProps) {
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
	} = useSindre()
	const panelRef = useRef<HTMLDivElement | null>(null)
	const isMobile = useIsMobile()

	const conversation = useSindreConversation({ workspaceId, sindreActorId })
	const {
		messages,
		conversations,
		activeId,
		newConversation,
		selectConversation,
		deleteConversation,
	} = conversation
	const hasMessages = messages.length > 0

	const buildExportMarkdown = useCallback(() => conversationToMarkdown(messages), [messages])

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(buildExportMarkdown())
			toast.success('Conversation copied as markdown')
		} catch (err) {
			console.error('[sindre] clipboard copy failed', err)
			toast.error('Could not copy — try Download instead')
		}
	}, [buildExportMarkdown])

	const handleDownload = useCallback(() => {
		downloadSindreMarkdown(buildExportMarkdown(), buildSindreExportFilename('Sindre'))
	}, [buildExportMarkdown])

	// In overlay mode (unpinned), close on outside click. Radix portals (picker
	// popovers, tooltips, dropdowns) render at document.body, so treat anything
	// inside a popper wrapper as "inside" to avoid closing on those clicks.
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
		<SindreSidebarProvider
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
					<div className="flex min-w-0 items-center gap-1">
						<ConversationSwitcher
							conversations={conversations}
							activeId={activeId}
							onSelect={selectConversation}
							onNew={newConversation}
							onDelete={deleteConversation}
						/>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="h-7 w-7"
									aria-label="Conversation menu"
									disabled={!hasMessages}
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
									onClick={newConversation}
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
							aria-label="Close Sindre"
						>
							<X size={15} />
						</Button>
					</div>
				</SidebarHeader>
				<SidebarContent className="min-h-0 flex-1 p-3">
					<ConversationView
						workspaceId={workspaceId}
						conversation={conversation}
						pendingMessage={pendingMessage}
						clearPendingMessage={clearPendingMessage}
						pendingAttachments={pendingAttachments}
						clearPendingAttachments={clearPendingAttachments}
					/>
				</SidebarContent>
			</Sidebar>
		</SindreSidebarProvider>
	)
}

/**
 * Thin vertical hit-target on the left edge of the Sindre panel. Captures
 * pointer events and reports the live drag width back via `onWidthChange`.
 * Clamping happens inside the Sindre context setter.
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
			aria-label="Resize Sindre panel"
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
