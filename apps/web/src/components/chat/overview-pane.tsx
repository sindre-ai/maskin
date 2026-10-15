import { ThreadsPane } from '@/components/chat/threads-pane'
import { ProducedPane } from '@/components/objects/produced-pane'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ProducedFileItem, ProducedObjectItem } from '@/hooks/use-conversation-produced'
import { cn } from '@/lib/cn'
import { Hand, Layers, X } from 'lucide-react'

export type OverviewTab = 'threads' | 'produced'

interface OverviewPaneProps {
	workspaceId: string
	conversationId: string
	tab: OverviewTab
	onTabChange: (tab: OverviewTab) => void
	/** Whether the actor has access to the Produced tab; it is not offered otherwise. */
	producedEnabled: boolean
	threadsCount: number
	producedCount: number
	/** Session open in the Threads tab; null shows the list. */
	openSessionId: string | null
	onOpenSession: (sessionId: string | null) => void
	producedObjects: ProducedObjectItem[]
	producedFiles: ProducedFileItem[]
	producedLoading: boolean
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
 * The chat's right rail: one pane, two tabs. Threads lists what the chat handed
 * off to other agents (and opens any of them as a thread); Produced lists the
 * objects and files those sessions made. A thread open in the Threads tab takes
 * over the whole pane with its own back / close header.
 */
export function OverviewPane({
	workspaceId,
	conversationId,
	tab,
	onTabChange,
	producedEnabled,
	threadsCount,
	producedCount,
	openSessionId,
	onOpenSession,
	producedObjects,
	producedFiles,
	producedLoading,
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
					<Tabs value={tab} onValueChange={(v) => onTabChange(v as OverviewTab)}>
						<TabsList>
							<TabsTrigger value="threads" className="gap-1">
								<Hand size={13} aria-hidden />
								Threads
								<CountPill n={threadsCount} />
							</TabsTrigger>
							{producedEnabled ? (
								<TabsTrigger value="produced" className="gap-1">
									<Layers size={13} aria-hidden />
									Produced
									<CountPill n={producedCount} />
								</TabsTrigger>
							) : null}
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
