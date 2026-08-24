import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ListFilter } from 'lucide-react'

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
 * The Chats screen's header action (mockup 220–228): a menu of All / Unread /
 * Pinned / Archived. The trigger names the active filter once it leaves "All"
 * and fills in so the narrowed state is visible without opening the menu.
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
					variant={isFiltered ? 'default' : 'outline'}
					size="sm"
					// 30px, not the sm default of 36px: this sits between the nav's
					// search button and the New split button, both of which are 30px.
					className="h-[30px] rounded-lg px-2.5 text-xs"
					aria-label={`Filter conversations — ${chatsFilterLabel(value)}`}
				>
					<ListFilter size={14} aria-hidden />
					{/* Icon-only on the narrowest phones: the shared nav row wraps rather
					    than scrolls, and this label was the difference between one line
					    and two at 375px. The filled variant still signals a narrowed
					    list, and the aria-label always names the active filter. */}
					<span className="hidden sm:inline">
						{isFiltered ? chatsFilterLabel(value) : 'Filter'}
					</span>
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
