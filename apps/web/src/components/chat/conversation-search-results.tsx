import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import type { useChatListSearch } from '@/hooks/use-chat-list-search'
import type { ConversationListItemResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { type LoadedList, hitLine, isArchivedHit } from '@/lib/conversation-search'
import { highlightText } from '@/lib/search-highlight'
import { rowTitle } from '@/lib/search/row-display'
import type { SearchResultRow } from '@maskin/shared'
import { Link } from '@tanstack/react-router'
import { MessageCircleWarning, SearchX } from 'lucide-react'
import { ConversationAvatarStack } from './conversation-avatar-stack'

interface ConversationSearchResultsProps {
	workspaceId: string
	query: string
	search: ReturnType<typeof useChatListSearch>
	/** Chats the list has already loaded: their people give a hit its avatar. */
	known: ReadonlyMap<string, ConversationListItemResponse>
	/** The default list, to tell which hits it leaves out. Null when a filter replaces it. */
	loaded: LoadedList | null
}

/**
 * The list search's results, in place of the grouped list while words are typed. A hit the
 * default list leaves out (archived, or quiet for a long while) carries a quiet Archived chip
 * and a dimmed avatar; the line under the title is the message that matched, highlighted.
 */
export function ConversationSearchResults({
	workspaceId,
	query,
	search,
	known,
	loaded,
}: ConversationSearchResultsProps) {
	const rows = search.data?.results ?? []
	if (search.isError && !search.data) {
		return (
			<EmptyState
				icon={<MessageCircleWarning size={24} aria-hidden="true" />}
				title="Couldn't search chats"
				description="Check your connection and try again."
				action={
					<Button variant="outline" size="sm" onClick={() => search.refetch()}>
						Try again
					</Button>
				}
			/>
		)
	}
	if (!search.data) return <ListSkeleton rows={6} />
	if (rows.length === 0) {
		return (
			<EmptyState
				icon={<SearchX size={24} aria-hidden="true" />}
				title="No chats found"
				description="No chat has that in its title, its people or its messages."
			/>
		)
	}
	return (
		<div
			data-testid="conversation-search-results"
			aria-busy={search.pending || search.isFetching}
			className={cn(
				'flex flex-col gap-px [&_mark]:rounded-sm [&_mark]:bg-warning/25 [&_mark]:text-foreground',
				(search.pending || search.isFetching) && 'opacity-60',
			)}
		>
			{rows.map((row) => (
				<SearchHit
					key={row.id}
					workspaceId={workspaceId}
					row={row}
					query={query}
					conversation={known.get(row.id)}
					archived={isArchivedHit(row, loaded)}
				/>
			))}
			{search.data.capped ? (
				<p className="px-2 pt-3 pb-2 text-center text-[11px] text-muted-foreground">
					Showing the first {rows.length} of {search.data.total} chats. Type more to narrow it.
				</p>
			) : null}
		</div>
	)
}

function SearchHit({
	workspaceId,
	row,
	query,
	conversation,
	archived,
}: {
	workspaceId: string
	row: SearchResultRow
	query: string
	conversation: ConversationListItemResponse | undefined
	archived: boolean
}) {
	const self = getStoredActor()
	const others = (conversation?.participants ?? []).filter((p) => p.actorId !== self?.id)
	const lead = others[0] ?? conversation?.participants[0]
	const line = hitLine(row, query)
	const title = rowTitle(row)
	return (
		<div className="border-t border-border first:border-t-0">
			<Link
				to="/$workspaceId/chats/$conversationId"
				params={{ workspaceId, conversationId: row.id }}
				activeProps={{ className: 'bg-accent' }}
				className="flex items-start gap-3 rounded-lg px-2 py-[11px] text-left hover:bg-accent"
			>
				<span
					className={cn('shrink-0', archived && 'opacity-50')}
					data-archived={archived || undefined}
				>
					{others.length > 1 ? (
						<ConversationAvatarStack participants={others} className="mt-1 w-[46px]" />
					) : (
						<ActorAvatar
							name={lead?.actorName ?? title}
							type={lead?.actorType ?? 'human'}
							id={lead?.actorId ?? row.id}
							size="md"
							className="mt-px size-8 shrink-0"
						/>
					)}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<span
							className={cn(
								'min-w-0 truncate text-sm font-semibold text-foreground',
								archived && 'text-muted-foreground',
							)}
						>
							{highlightText(title, query)}
						</span>
						{archived ? (
							<span className="shrink-0 rounded-full bg-secondary px-1.5 py-px text-[11px] font-medium text-muted-foreground">
								Archived
							</span>
						) : null}
						{row.updatedAt ? (
							<RelativeTime
								date={row.updatedAt}
								format="clock"
								className="ml-auto shrink-0 text-xs text-muted-foreground"
							/>
						) : null}
					</div>
					{line ? (
						<div className="mt-0.5 truncate text-[13px] text-muted-foreground">
							{highlightText(line, query)}
						</div>
					) : null}
				</div>
			</Link>
		</div>
	)
}
