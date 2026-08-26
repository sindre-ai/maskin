import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import { Ellipsis } from 'lucide-react'

export type ChatsFilter = 'all' | 'unread' | 'pinned' | 'archived'

export const CHATS_FILTERS: Array<{ value: ChatsFilter; label: string }> = [
	{ value: 'all', label: 'All' },
	{ value: 'unread', label: 'Unread' },
	{ value: 'pinned', label: 'Pinned' },
	{ value: 'archived', label: 'Archived' },
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
}: {
	value: ChatsFilter
	onChange: (value: ChatsFilter) => void
}) {
	const isFiltered = value !== 'all'
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className={cn(
						'h-[30px] gap-1.5 px-2.5 text-[11.5px] font-semibold',
						isFiltered && 'border-border-strong text-foreground',
					)}
					aria-label={`Filter conversations — ${chatsFilterLabel(value)}`}
				>
					{isFiltered ? <span className="whitespace-nowrap">{chatsFilterLabel(value)}</span> : null}
					<Ellipsis size={15} aria-hidden />
				</Button>
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
