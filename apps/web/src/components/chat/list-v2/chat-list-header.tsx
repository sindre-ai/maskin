import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ChatListGroupBy } from '@/lib/analytics'
import { CHAT_GROUP_BY } from '@/lib/chat-list-v2'
import { cn } from '@/lib/cn'
import { focusField, usePageSearchShortcut } from '@/lib/page-search-shortcut'
import { Link } from '@tanstack/react-router'
import { ListFilter, Plus } from 'lucide-react'
import { useRef, useState } from 'react'
import type { ChatsFilter } from '../chats-filter-menu'
import { ChatSearchField } from './chat-search-field'

/** The ··· menu next to search: Group by, and the two lists the pills do not cover. */
function ChatListMenu({
	groupBy,
	onGroupByChange,
	filter,
	onFilterChange,
	iconOnly,
}: {
	groupBy: ChatListGroupBy
	onGroupByChange: (next: ChatListGroupBy) => void
	filter: ChatsFilter
	onFilterChange: (next: ChatsFilter) => void
	iconOnly?: boolean
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					title="Group and filter"
					aria-label="Group and filter chats"
					className={cn(
						'relative size-8 rounded-full bg-background shadow-[inset_0_0_0_1px_var(--border)] hover:bg-secondary touch-hit',
						!iconOnly && 'max-md:size-11',
					)}
				>
					<ListFilter className="size-3.5" aria-hidden />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48">
				<DropdownMenuLabel>Group by</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={groupBy}
					onValueChange={(next) => onGroupByChange(next as ChatListGroupBy)}
				>
					{CHAT_GROUP_BY.map((g) => (
						<DropdownMenuRadioItem key={g.value} value={g.value}>
							{g.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				{filter !== 'all' ? (
					<DropdownMenuItem onSelect={() => onFilterChange('all')}>All chats</DropdownMenuItem>
				) : null}
				<DropdownMenuItem onSelect={() => onFilterChange('archived')}>Archived</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => onFilterChange('threads')}>Threads</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

/**
 * The list column's head for the new list. Desktop: the "Chats" title, a search that is a round icon
 * until it has focus or text, the Group by menu and New chat. Below md the shared nav row carries the
 * title and New chat, so only search and the menu are drawn here.
 */
export function ChatListHeader({
	filter,
	onFilterChange,
	groupBy,
	onGroupByChange,
	query,
	onQueryChange,
	workspaceId,
	titled,
	pageTitle = true,
}: {
	filter: ChatsFilter
	onFilterChange: (next: ChatsFilter) => void
	groupBy: ChatListGroupBy
	onGroupByChange: (next: ChatListGroupBy) => void
	query: string
	onQueryChange: (next: string) => void
	workspaceId: string
	/** Draw the title and New chat here (desktop); false leaves them to the nav row. */
	titled: boolean
	/** The title is the page's h1. False on the new-chat screen. */
	pageTitle?: boolean
}) {
	const searchRef = useRef<HTMLInputElement>(null)
	const [focused, setFocused] = useState(false)
	usePageSearchShortcut(() => focusField(searchRef.current))
	const expanded = focused || query !== ''
	const menu = (
		<ChatListMenu
			groupBy={groupBy}
			onGroupByChange={onGroupByChange}
			filter={filter}
			onFilterChange={onFilterChange}
			iconOnly={titled}
		/>
	)

	if (!titled) {
		return (
			<div className="flex flex-none items-start gap-2 px-4 pt-3 pb-3 lg:pl-7">
				<ChatSearchField
					workspaceId={workspaceId}
					value={query}
					onChange={onQueryChange}
					inputRef={searchRef}
					className="flex h-[34px] w-full min-w-0 items-center gap-2 rounded-full bg-secondary px-3 text-muted-foreground max-md:min-h-11 pointer-coarse:min-h-11"
					inputClassName="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
				{menu}
			</div>
		)
	}
	const Heading = pageTitle ? 'h1' : 'h2'
	return (
		<div className="flex flex-none items-center gap-2 pr-5 pb-4 pl-7">
			<Heading
				className={cn('page-title min-w-0 flex-1 truncate', expanded && 'sr-only flex-none')}
			>
				Chats
			</Heading>
			<ChatSearchField
				workspaceId={workspaceId}
				value={query}
				onChange={onQueryChange}
				onFocusChange={setFocused}
				inputRef={searchRef}
				wrapperClassName={expanded ? 'flex-1' : 'w-8 flex-none'}
				className={cn(
					'flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-full bg-background px-[9px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]',
					expanded && 'cursor-text',
				)}
				inputClassName="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
			/>
			<div className={cn('flex flex-none items-center gap-2', expanded && 'hidden')}>
				{menu}
				<Button
					asChild
					size="icon"
					className="size-8 rounded-full"
					aria-label="New chat"
					title="New chat"
				>
					<Link to="/$workspaceId/chats/new" params={{ workspaceId }}>
						<Plus size={14} strokeWidth={2.6} aria-hidden />
					</Link>
				</Button>
			</div>
		</div>
	)
}
