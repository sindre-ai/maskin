import { cn } from '@/lib/cn'
import { TYPE_LABELS, statusLabel } from '@/lib/constants'
import { highlightText } from '@/lib/search-highlight'
import { rowSub, rowTitle } from '@/lib/search/row-display'
import type { SearchResultRow, SearchSourceGroup } from '@maskin/shared'
import { ChevronRight } from 'lucide-react'

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

// v3 row: the title over one grey meta line ("Bet · Proposed") with a chevron at the right.
// The matched snippet is for chats only.
function ResultRow({ row, query, id, active, onOpen }: RowProps) {
	const sub = rowSub(row)
	const kind =
		row.group === 'objects' ? (TYPE_LABELS[row.type] ?? KIND_WORD.objects) : KIND_WORD[row.group]
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
				'flex w-full cursor-pointer items-center gap-3 border-t border-border px-2 py-2.5 text-left transition-colors hover:bg-secondary max-lg:min-h-11 pointer-coarse:min-h-11',
				active && 'bg-secondary',
			)}
		>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-[15px] font-medium text-foreground">
					{highlightText(rowTitle(row), query)}
				</span>
				<span className="truncate text-[13px] text-muted-foreground">
					{[kind, row.group === 'people' ? null : statusLabel(row.status), sub]
						.filter(Boolean)
						.join(' · ')}
				</span>
				{row.group === 'chats' && row.snippet ? (
					<span className="truncate text-xs leading-normal text-muted-foreground">
						{highlightText(row.snippet, query)}
					</span>
				) : null}
			</span>
			<ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
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
				'flex flex-col pb-8 pt-1 transition-opacity [&_mark]:bg-warning/25 [&_mark]:text-foreground',
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
									className="px-2 pb-2 pt-4 text-[13px] font-semibold text-muted-foreground"
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
