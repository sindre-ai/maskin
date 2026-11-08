import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PILL_TRIGGER_CLASS } from '@/components/ui/select'
import { cn } from '@/lib/cn'
import { ChevronDown, ListFilter } from 'lucide-react'

export type ChatsFilter = 'all' | 'unread' | 'pinned' | 'archived' | 'threads'

export const CHATS_FILTERS: Array<{ value: ChatsFilter; label: string }> = [
	{ value: 'all', label: 'All' },
	{ value: 'unread', label: 'Unread' },
	{ value: 'pinned', label: 'Pinned' },
	{ value: 'archived', label: 'Archived' },
	{ value: 'threads', label: 'Threads' },
]

export function chatsFilterLabel(filter: ChatsFilter): string {
	return CHATS_FILTERS.find((f) => f.value === filter)?.label ?? 'All'
}

/**
 * The Chats screen's header action (mockup 196–206): an unlabelled `···`
 * that stays out of the way while the list is unfiltered, and grows the
 * active filter's name beside the glyph once it leaves "All" — so the
 * narrowed state is readable without opening the menu. The icon-plus-"Filter"
 * button it replaced competed with the split New button for the same row.
 */
export function ChatsFilterMenu({
	value,
	onChange,
	iconOnly,
}: {
	value: ChatsFilter
	onChange: (value: ChatsFilter) => void
	/** The v3 list head: a 32px round filter icon instead of the labelled pill. */
	iconOnly?: boolean
}) {
	const isFiltered = value !== 'all'
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				{iconOnly ? (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						title={`Filter — ${chatsFilterLabel(value)}`}
						className={cn(
							'size-8 rounded-full bg-background shadow-[inset_0_0_0_1px_var(--border)] hover:bg-secondary',
							isFiltered && 'bg-secondary shadow-[inset_0_0_0_1px_var(--border-strong)]',
						)}
						aria-label={`Filter conversations — ${chatsFilterLabel(value)}`}
					>
						<ListFilter className="size-3.5" aria-hidden />
					</Button>
				) : (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={cn(
							PILL_TRIGGER_CLASS,
							'inline-flex hover:bg-background',
							isFiltered && 'border-border-strong',
						)}
						aria-label={`Filter conversations — ${chatsFilterLabel(value)}`}
					>
						<span className="whitespace-nowrap">
							{isFiltered ? chatsFilterLabel(value) : 'All chats'}
						</span>
						<ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
					</Button>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-44">
				<DropdownMenuRadioGroup
					value={value}
					onValueChange={(next) => onChange(next as ChatsFilter)}
				>
					{CHATS_FILTERS.map((f) => (
						<DropdownMenuRadioItem key={f.value} value={f.value}>
							{f.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
