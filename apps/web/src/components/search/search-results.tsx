import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { TypeBadge } from '@/components/shared/type-badge'
import { cn } from '@/lib/cn'
import { statusLabel } from '@/lib/constants'
import { highlightText } from '@/lib/search-highlight'
import { rowSub, rowTitle } from '@/lib/search/row-display'
import type { SearchResultRow, SearchSourceGroup } from '@maskin/shared'
import { MessageSquare, RefreshCw, Zap } from 'lucide-react'
import { statusDotClass } from './search-chips'

export const GROUP_LABEL: Record<SearchSourceGroup, string> = {
	chats: 'Chats',
	loops: 'Flows',
	agents: 'Agents',
	people: 'People',
	objects: 'Items',
	automations: 'Automations',
}

const KIND_WORD: Record<SearchSourceGroup, string> = {
	chats: 'Chat',
	loops: 'Flow',
	agents: 'Agent',
	people: 'Person',
	objects: 'Item',
	automations: 'Automation',
}

const GROUP_ORDER: SearchSourceGroup[] = [
	'chats',
	'loops',
	'agents',
	'people',
	'objects',
	'automations',
]

const GROUP_GLYPH: Partial<Record<SearchSourceGroup, typeof MessageSquare>> = {
	chats: MessageSquare,
	loops: RefreshCw,
	automations: Zap,
}

/** DOM id of a result option; the field points at it with aria-activedescendant. */
export function optionId(listboxId: string, row: SearchResultRow): string {
	return `${listboxId}-${row.group}-${row.id}`
}

/**
 * The rows in the order they are drawn. Under Relevance the rows come grouped by
 * type (the endpoint sends the groups in a fixed order); under Recently updated and
 * A to Z they are one flat list. Position in this list is the position analytics reports.
 */
export function orderRows(
	rows: SearchResultRow[],
	sort: 'rel' | 'recent' | 'az',
): SearchResultRow[] {
	if (sort !== 'rel') return rows
	return GROUP_ORDER.flatMap((group) => rows.filter((row) => row.group === group))
}

interface RowProps {
	row: SearchResultRow
	query: string
	id: string
	active: boolean
	onOpen: (row: SearchResultRow) => void
}

export function RowIcon({
	row,
}: { row: Pick<SearchResultRow, 'id' | 'group' | 'type' | 'title'> }) {
	const Glyph = GROUP_GLYPH[row.group]
	if (row.group === 'objects') {
		return <TypeBadge type={row.type} variant="tile" className="size-7 shrink-0 rounded-lg" />
	}
	if (row.group === 'agents') {
		return (
			<ActorAvatar
				id={row.id}
				name={row.title}
				type="agent"
				className="size-7 shrink-0 text-[10px]"
			/>
		)
	}
	if (row.group === 'people') {
		return (
			<ActorAvatar
				id={row.id}
				name={row.title}
				type="human"
				className="size-7 shrink-0 text-[10px]"
			/>
		)
	}
	return Glyph ? (
		<span
			aria-hidden="true"
			className="grid size-7 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground"
		>
			<Glyph className="size-[15px]" />
		</span>
	) : null
}

// v3 row: a kind tile, the title over one meta line ("Item · Waiting on you · Strategist"),
// and the date at the right. The matched snippet is for chats only.
function ResultRow({ row, query, id, active, onOpen }: RowProps) {
	const sub = rowSub(row)
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard use goes through the search field (combobox with aria-activedescendant), not through focus on the row
		<div
			id={id}
			// biome-ignore lint/a11y/useSemanticElements: an option of an ARIA listbox that the search field controls; <option> belongs to <select>
			role="option"
			tabIndex={-1}
			aria-selected={active}
			onClick={() => onOpen(row)}
			className={cn(
				'flex w-full cursor-pointer items-center gap-3 border-t border-border px-1 py-2.5 text-left transition-colors hover:bg-secondary max-lg:min-h-11 pointer-coarse:min-h-11',
				active && 'bg-secondary',
			)}
		>
			<RowIcon row={row} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-sm font-medium text-foreground">
					{highlightText(rowTitle(row), query)}
				</span>
				<span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
					{row.group === 'people' ? null : (
						<span
							aria-hidden="true"
							className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(row.statusGroup))}
						/>
					)}
					<span className="truncate">
						{[KIND_WORD[row.group], row.group === 'people' ? null : statusLabel(row.status), sub]
							.filter(Boolean)
							.join(' · ')}
					</span>
				</span>
				{row.group === 'chats' && row.snippet ? (
					<span className="truncate text-xs leading-normal text-muted-foreground">
						{highlightText(row.snippet, query)}
					</span>
				) : null}
			</span>
			{row.updatedAt ? (
				<RelativeTime
					date={row.updatedAt}
					compact
					className="shrink-0 text-xs text-muted-foreground"
				/>
			) : null}
		</div>
	)
}

interface ListProps {
	rows: SearchResultRow[]
	sort: 'rel' | 'recent' | 'az'
	query: string
	listboxId: string
	activeId: string | undefined
	/** The previous answer is on screen while a new one loads. */
	dimmed: boolean
	onOpen: (row: SearchResultRow) => void
}

export function SearchResultList({
	rows,
	sort,
	query,
	listboxId,
	activeId,
	dimmed,
	onOpen,
}: ListProps) {
	const renderRow = (row: SearchResultRow) => {
		const id = optionId(listboxId, row)
		return (
			<ResultRow
				key={id}
				row={row}
				query={query}
				id={id}
				active={id === activeId}
				onOpen={onOpen}
			/>
		)
	}
	return (
		// biome-ignore lint/a11y/useFocusableInteractive: focus stays in the search field, the listbox is never tabbed to
		<div
			id={listboxId}
			// biome-ignore lint/a11y/useSemanticElements: the results are an ARIA listbox that the search field controls (aria-activedescendant); <select> is for form values
			role="listbox"
			aria-label="Search results"
			aria-busy={dimmed}
			className={cn(
				'flex flex-col px-3 pb-8 pt-3 transition-opacity md:px-5 [&_mark]:bg-warning/25 [&_mark]:text-foreground',
				dimmed && 'opacity-60',
			)}
		>
			{sort === 'rel'
				? GROUP_ORDER.map((group) => {
						const groupRows = rows.filter((row) => row.group === group)
						if (groupRows.length === 0) return null
						return (
							<div
								key={group}
								// biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role=group; <fieldset> is for form controls
								role="group"
								aria-label={GROUP_LABEL[group]}
								className="flex flex-col"
							>
								<div
									aria-hidden="true"
									className="px-1 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"
								>
									{GROUP_LABEL[group]} · {groupRows.length}
								</div>
								{groupRows.map(renderRow)}
							</div>
						)
					})
				: rows.map(renderRow)}
		</div>
	)
}
