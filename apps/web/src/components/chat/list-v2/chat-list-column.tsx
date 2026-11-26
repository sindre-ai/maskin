import { ConversationList } from '@/components/chat/conversation-list'
import type { ChatListGroupBy } from '@/lib/analytics'
import type { ChatPill } from '@/lib/chat-list-v2'
import { useCallback, useState } from 'react'
import type { ChatsFilter } from '../chats-filter-menu'
import { ChatListV2 } from './chat-list'
import { ChatListHeader } from './chat-list-header'

const GROUP_BY_KEY = 'chat-list-group-by'
const GROUP_BY_VALUES: ChatListGroupBy[] = ['date', 'status', 'agent', 'tag', 'type', 'none']

/** Group by sticks between visits, like the other list display choices. Date is the default. */
export function usePersistedGroupBy(): [ChatListGroupBy, (next: ChatListGroupBy) => void] {
	const [groupBy, setGroupBy] = useState<ChatListGroupBy>(() => {
		try {
			const stored = localStorage.getItem(GROUP_BY_KEY)
			return GROUP_BY_VALUES.find((v) => v === stored) ?? 'date'
		} catch {
			return 'date'
		}
	})
	const update = useCallback((next: ChatListGroupBy) => {
		setGroupBy(next)
		try {
			localStorage.setItem(GROUP_BY_KEY, next)
		} catch {
			// A browser that refuses storage still groups for this visit.
		}
	}, [])
	return [groupBy, update]
}

/**
 * The new chat list's whole column: head, pills and list. Archived, Threads and Pinned stay on the
 * lists they have today (they are not pills), so the column hands those to the existing list.
 */
export function ChatListColumn({
	workspaceId,
	filter,
	onFilterChange,
	pill,
	onPillChange,
	query,
	onQueryChange,
	titled,
	pageTitle,
	hideStartLink,
}: {
	workspaceId: string
	filter: ChatsFilter
	onFilterChange: (next: ChatsFilter) => void
	pill: ChatPill
	onPillChange: (next: ChatPill) => void
	query: string
	onQueryChange: (next: string) => void
	titled: boolean
	pageTitle?: boolean
	hideStartLink?: boolean
}) {
	const [groupBy, setGroupBy] = usePersistedGroupBy()
	// A link that still says ?filter=unread lands on the Unread pill.
	const activePill: ChatPill = filter === 'unread' ? 'unread' : pill
	const legacyList = filter === 'archived' || filter === 'threads' || filter === 'pinned'
	return (
		<>
			<ChatListHeader
				workspaceId={workspaceId}
				titled={titled}
				pageTitle={pageTitle}
				filter={filter}
				onFilterChange={onFilterChange}
				groupBy={groupBy}
				onGroupByChange={setGroupBy}
				query={query}
				onQueryChange={onQueryChange}
			/>
			{legacyList ? (
				<ConversationList
					workspaceId={workspaceId}
					filter={filter}
					query={query}
					hideStartLink={hideStartLink}
				/>
			) : (
				<ChatListV2
					workspaceId={workspaceId}
					pill={activePill}
					onPillChange={onPillChange}
					groupBy={groupBy}
					query={query}
					hideStartLink={hideStartLink}
				/>
			)}
		</>
	)
}
