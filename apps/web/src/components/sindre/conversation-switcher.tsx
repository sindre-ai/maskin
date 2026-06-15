import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RelativeTime } from '@/components/shared/relative-time'
import type { ConversationSummary } from '@/hooks/use-sindre-conversation'
import { cn } from '@/lib/cn'
import { Check, ChevronDown, MessageSquarePlus, Trash2 } from 'lucide-react'

interface ConversationSwitcherProps {
	conversations: ConversationSummary[]
	activeId: string | null
	onSelect: (id: string) => void
	onNew: () => void
	onDelete: (id: string) => void
}

/**
 * Header control that shows the active conversation title and opens a history
 * list of recent conversations (most-recent first), with inline delete and a
 * "New conversation" action — the chat's equivalent of v0/Claude's sidebar
 * history, condensed into the panel header.
 */
export function ConversationSwitcher({
	conversations,
	activeId,
	onSelect,
	onNew,
	onDelete,
}: ConversationSwitcherProps) {
	const active = conversations.find((c) => c.id === activeId)
	const title = active?.title ?? 'New conversation'

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					className="-ml-1 h-7 max-w-[12rem] gap-1 px-1.5 font-semibold text-base"
					aria-label="Switch conversation"
				>
					<span className="truncate">{title}</span>
					<ChevronDown size={15} className="shrink-0 text-text-muted" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-72">
				<DropdownMenuItem onSelect={onNew}>
					<MessageSquarePlus size={14} />
					New conversation
				</DropdownMenuItem>
				{conversations.length > 0 ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-text-muted text-xs">Recent</DropdownMenuLabel>
						{conversations.map((c) => (
							<DropdownMenuItem
								key={c.id}
								onSelect={() => onSelect(c.id)}
								className="group flex items-center gap-2"
							>
								<Check
									size={14}
									className={cn('shrink-0', c.id === activeId ? 'opacity-100' : 'opacity-0')}
								/>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-sm">{c.title}</span>
									<RelativeTime
										date={new Date(c.updatedAt).toISOString()}
										className="text-text-muted text-xs"
									/>
								</span>
								<button
									type="button"
									aria-label={`Delete ${c.title}`}
									className="shrink-0 rounded p-1 text-text-muted opacity-0 hover:bg-bg-hover hover:text-error group-hover:opacity-100"
									onClick={(e) => {
										e.stopPropagation()
										e.preventDefault()
										onDelete(c.id)
									}}
								>
									<Trash2 size={13} />
								</button>
							</DropdownMenuItem>
						))}
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
