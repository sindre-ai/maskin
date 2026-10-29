import { ActorAvatar } from '@/components/shared/actor-avatar'
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
	loops: 'Loops',
	agents: 'Agents',
	objects: 'Objects',
	automations: 'Automations',
}

const GROUP_ORDER: SearchSourceGroup[] = ['chats', 'loops', 'agents', 'objects', 'automations']

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
		return (
			<TypeBadge type={row.type} variant="tile" className="mt-px size-[22px] shrink-0 rounded-md" />
		)
	}
	if (row.group === 'agents') {
		return (
			<ActorAvatar
				id={row.id}
				name={row.title}
				type="agent"
				className="mt-px size-[22px] shrink-0 text-[9px]"
			/>
		)
	}
	return Glyph ? (
		<span
			aria-hidden="true"
			className="mt-px grid size-[22px] shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
		>
			<Glyph className="size-[13px]" />
		</span>
	) : null
}

// Live row structure and 13px scale: title with a muted suffix, kind in the right
// column, status as a muted suffix with one 6px dot. Snippets are for chats only.
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
				'flex w-full cursor-pointer items-start gap-[11px] rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-accent max-[1024.02px]:min-h-11',
				active && 'border-border bg-accent',
			)}
		>
			<RowIcon row={row} />
			<span className="flex min-w-0 flex-1 flex-col gap-[3px]">
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="min-w-0 truncate text-[13px] font-semibold text-foreground">
						{highlightText(rowTitle(row), query)}
						{sub ? <span className="font-normal text-muted-foreground"> — {sub}</span> : null}
					</span>
					<span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
						<span
							aria-hidden="true"
							className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(row.statusGroup))}
						/>
						{statusLabel(row.status)}
					</span>
				</span>
				{row.group === 'chats' && row.snippet ? (
					<span className="truncate text-xs leading-normal text-muted-foreground">
						{highlightText(row.snippet, query)}
					</span>
				) : null}
			</span>
			<span className="mt-0.5 shrink-0 font-mono text-[9.5px] font-semibold tracking-[0.05em] text-muted-foreground">
				{row.type.replace(/_/g, ' ').toUpperCase()}
			</span>
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
				'flex flex-col gap-0.5 px-3 pb-8 pt-3 transition-opacity md:px-5',
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
								className="flex flex-col gap-0.5"
							>
								<div aria-hidden="true" className="eyebrow px-1 pb-1 pt-3">
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
