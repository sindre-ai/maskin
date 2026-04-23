import { SindreChat, type SindreChatHandle } from '@/components/sindre/sindre-chat'
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
import { getStoredActor } from '@/lib/auth'
import { type SindreAttachment, useSindre } from '@/lib/sindre-context'
import {
	buildSindreExportFilename,
	downloadSindreMarkdown,
	formatSindreMarkdown,
} from '@/lib/sindre-export'
import {
	EMPTY_SINDRE_SELECTION,
	type SindreSelectionAgent,
	type SindreSelectionNotification,
	type SindreSelectionObject,
	sindreSelectionReducer,
} from '@/lib/sindre-selection'
import type { SindreEvent } from '@/lib/sindre-stream'
import { Copy, Download, MoreHorizontal, Pin, PinOff, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

const SINDRE_AGENT_NAME = 'Sindre'

interface SindrePanelProps {
	workspaceId: string
	sindreActorId: string | null
}

/**
 * Right-side Sindre surface. Wraps `<SindreChat surface="sheet" />` in a
 * shadcn `<Sidebar>` inside a local provider that never reserves horizontal
 * space in the main page layout (so the panel floats as an overlay by
 * default). When the user clicks the pin button, the route layout applies a
 * matching right margin to the main content so the panel pushes content
 * aside like a traditional sidebar.
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
	} = useSindre()
	const [selection, dispatch] = useReducer(sindreSelectionReducer, EMPTY_SINDRE_SELECTION)
	const panelRef = useRef<HTMLDivElement | null>(null)
	const chatRef = useRef<SindreChatHandle | null>(null)
	const [events, setEvents] = useState<SindreEvent[]>([])

	const handleNewChat = useCallback(() => {
		chatRef.current?.newChat()
	}, [])

	const buildExportMarkdown = useCallback(() => {
		const actor = getStoredActor()
		return formatSindreMarkdown(events, {
			workspaceId,
			frontendUrl:
				typeof window !== 'undefined' ? window.location.origin : 'https://maskin.sindre.ai',
			userName: actor?.name?.trim() || 'You',
			agentName: SINDRE_AGENT_NAME,
		})
	}, [events, workspaceId])

	const handleCopy = useCallback(async () => {
		const md = buildExportMarkdown()
		try {
			await navigator.clipboard.writeText(md)
		} catch {
			// Clipboard access is best-effort; fall back silently.
		}
	}, [buildExportMarkdown])

	const handleDownload = useCallback(() => {
		const md = buildExportMarkdown()
		downloadSindreMarkdown(md, buildSindreExportFilename(SINDRE_AGENT_NAME))
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
	// Sheet behaviour. When pinned, Sindre is docked and should survive clicks
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
		<SindreSidebarProvider
			open={open}
			onOpenChange={setOpen}
			style={{ '--sidebar-width': '28rem' } as React.CSSProperties}
		>
			<Sidebar
				ref={panelRef}
				side="right"
				collapsible="offcanvas"
				className="pointer-events-auto"
			>
				<SidebarHeader className="flex-row items-center justify-between gap-2 border-b border-border px-3 py-2">
					<div className="flex items-center gap-1">
						<h2 className="font-semibold text-base">Sindre</h2>
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
						<PinToggle pinned={pinned} onToggle={() => setPinned(!pinned)} />
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
					<SindreChat
						ref={chatRef}
						workspaceId={workspaceId}
						sindreActorId={sindreActorId}
						surface="sheet"
						selection={selection}
						onDispatchSelection={dispatch}
						autoSendMessage={pendingMessage}
						onAutoSendConsumed={clearPendingMessage}
						onEventsChange={setEvents}
					/>
				</SidebarContent>
			</Sidebar>
		</SindreSidebarProvider>
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

function attachmentToAction(attachment: SindreAttachment) {
	if (attachment.kind === 'agent') {
		const agent: SindreSelectionAgent = {
			id: attachment.id,
			name: attachment.name ?? null,
		}
		return { type: 'add_agent' as const, agent }
	}
	if (attachment.kind === 'object') {
		const object: SindreSelectionObject = {
			id: attachment.id,
			title: attachment.title ?? null,
			type: attachment.type ?? null,
		}
		return { type: 'add_object' as const, object }
	}
	if (attachment.kind === 'notification') {
		const notification: SindreSelectionNotification = {
			id: attachment.id,
			title: attachment.title ?? null,
		}
		return { type: 'add_notification' as const, notification }
	}
	return null
}
