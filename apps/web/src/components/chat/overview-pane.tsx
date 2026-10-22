import { ComputersPane } from '@/components/chat/computers-pane'
import { type LinkedFocus, LinkedPane } from '@/components/chat/linked-pane'
import { ThreadsPane } from '@/components/chat/threads-pane'
import { ProducedPane } from '@/components/objects/produced-pane'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { LinkedItem } from '@/hooks/use-conversation-linked'
import type { ProducedFileItem, ProducedObjectItem } from '@/hooks/use-conversation-produced'
import { cn } from '@/lib/cn'
import { Hand, Layers, Link2, Monitor, X } from 'lucide-react'

export type OverviewTab = 'threads' | 'produced' | 'linked' | 'computers'

interface OverviewPaneProps {
	workspaceId: string
	conversationId: string
	tab: OverviewTab
	onTabChange: (tab: OverviewTab) => void
	threadsCount: number
	/** How many agents in the chat have a computer to show. */
	computersCount: number
	producedCount: number
	/** Session open in the Threads tab; null shows the list. */
	openSessionId: string | null
	onOpenSession: (sessionId: string | null) => void
	producedObjects: ProducedObjectItem[]
	producedFiles: ProducedFileItem[]
	producedLoading: boolean
	linkedItems: LinkedItem[]
	/** How many of them resolve to something the tab shows. */
	linkedCount: number
	/** The item a card asked the drawer to show; highlighted and expanded in the Linked tab. */
	linkedFocus: LinkedFocus | null
	onFocusConsumed: () => void
	onJumpToMessage: (messageId: number) => void
	onClose: () => void
	className?: string
}

function CountPill({ n }: { n: number }) {
	return (
		<span className="ml-1 inline-flex min-w-[16px] items-center justify-center rounded-full bg-muted px-1 text-[10px] font-bold text-muted-foreground">
			{n}
		</span>
	)
}

/**
 * The chat's right rail: one pane, four tabs. Threads lists what the chat handed
 * off to other agents (and opens any of them as a thread); Produced lists the
 * objects and files those sessions made; Linked lists what the chat's messages link to. A thread open in the Threads tab takes
 * over the whole pane with its own back / close header.
 */
export function OverviewPane({
	workspaceId,
	conversationId,
	tab,
	onTabChange,
	threadsCount,
	computersCount,
	producedCount,
	openSessionId,
	onOpenSession,
	producedObjects,
	producedFiles,
	producedLoading,
	linkedItems,
	linkedCount,
	linkedFocus,
	onFocusConsumed,
	onJumpToMessage,
	onClose,
	className,
}: OverviewPaneProps) {
	const threadOpen = tab === 'threads' && openSessionId !== null

	return (
		<div
			className={cn('flex h-full min-h-0 w-full flex-col bg-surface-sunken', className)}
			aria-label="Overview"
		>
			{threadOpen ? null : (
				<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
					<Tabs
						value={tab}
						onValueChange={(v) => onTabChange(v as OverviewTab)}
						className="min-w-0 overflow-x-auto"
					>
						<TabsList>
							<TabsTrigger value="threads" className="gap-1">
								<Hand size={13} aria-hidden />
								Threads
								<CountPill n={threadsCount} />
							</TabsTrigger>
							<TabsTrigger value="produced" className="gap-1">
								<Layers size={13} aria-hidden />
								Produced
								<CountPill n={producedCount} />
							</TabsTrigger>
							<TabsTrigger value="computers" className="gap-1">
								<Monitor size={13} aria-hidden />
								Computers
								<CountPill n={computersCount} />
							</TabsTrigger>
							<TabsTrigger value="linked" className="gap-1">
								<Link2 size={13} aria-hidden />
								Linked
								<CountPill n={linkedCount} />
							</TabsTrigger>
						</TabsList>
					</Tabs>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="h-6 w-6"
						onClick={onClose}
						aria-label="Close Overview"
					>
						<X size={14} />
					</Button>
				</div>
			)}
			{tab === 'threads' ? (
				<ThreadsPane
					workspaceId={workspaceId}
					conversationId={conversationId}
					openSessionId={openSessionId}
					onOpenSession={onOpenSession}
					onClose={onClose}
					className="min-h-0 flex-1"
				/>
			) : tab === 'computers' ? (
				<ComputersPane
					workspaceId={workspaceId}
					conversationId={conversationId}
					className="min-h-0 flex-1"
				/>
			) : tab === 'linked' ? (
				<LinkedPane
					workspaceId={workspaceId}
					conversationId={conversationId}
					items={linkedItems}
					focus={linkedFocus}
					onFocusConsumed={onFocusConsumed}
					onJumpToMessage={onJumpToMessage}
					className="min-h-0 flex-1"
				/>
			) : (
				<ProducedPane
					workspaceId={workspaceId}
					producedObjects={producedObjects}
					producedFiles={producedFiles}
					isLoading={producedLoading}
					hideHeader
					className="min-h-0 flex-1"
				/>
			)}
		</div>
	)
}
