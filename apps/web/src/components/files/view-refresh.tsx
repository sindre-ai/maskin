import { Button } from '@/components/ui/button'
import { trackViewRefreshed } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import {
	type ListAnswer,
	type ListRow,
	type ListSource,
	type ListSourceEntry,
	fetchListRows,
} from '@/lib/view-lists'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

/** A view older than this is flagged amber. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

type RefreshStatus = 'idle' | 'loading' | 'error'

export interface ViewRefresh {
	status: RefreshStatus
	/** When the rows on screen were fetched, or null before the first successful Refresh. */
	fetchedAt: number | null
	/** Goes up by one after every successful Refresh; the stage uses it to replace the frame so the view asks again. */
	generation: number
	/** What a list source is answered with. Rows exist only after a Refresh click. */
	answer: (name: string, source: ListSource) => ListAnswer
	refresh: () => void
}

/**
 * Holds the rows of the file viewer's list sources. Nothing is fetched on open or on a
 * timer: `refresh` runs only from the Refresh button. A source's rows are kept with the
 * declaration they were fetched for, so a file that is rewritten with a different
 * declaration is never answered with the old rows.
 */
export function useViewRefresh(
	workspaceId: string,
	fileId: string,
	lists: ReadonlyMap<string, ListSourceEntry>,
): ViewRefresh {
	const [state, setState] = useState<{
		status: RefreshStatus
		fetchedAt: number | null
		generation: number
	}>({ status: 'idle', fetchedAt: null, generation: 0 })
	const results = useRef(
		new Map<string, { declaration: string; rows: ListRow[]; fetchedAt: number }>(),
	)
	const listsRef = useRef(lists)
	listsRef.current = lists
	const inFlight = useRef(false)

	const answer = useCallback((name: string, source: ListSource): ListAnswer => {
		const held = results.current.get(name)
		if (!held || held.declaration !== JSON.stringify(source)) {
			return { rows: null, notRefreshed: true }
		}
		return { rows: held.rows, fetchedAt: held.fetchedAt }
	}, [])

	const refresh = useCallback(() => {
		if (inFlight.current) return
		const declared = [...listsRef.current].filter(
			(entry): entry is [string, ListSource] => entry[1] !== null,
		)
		const listNames = [...new Set(declared.map(([, source]) => source.list))].join(',')
		inFlight.current = true
		setState((s) => ({ ...s, status: 'loading' }))
		Promise.all(
			declared.map(async ([name, source]) => ({
				name,
				source,
				rows: await fetchListRows(workspaceId, source),
			})),
		)
			.then((fetched) => {
				const at = Date.now()
				results.current = new Map(
					fetched.map(({ name, source, rows }) => [
						name,
						{ declaration: JSON.stringify(source), rows, fetchedAt: at },
					]),
				)
				setState((s) => ({ status: 'idle', fetchedAt: at, generation: s.generation + 1 }))
				trackViewRefreshed({
					entity_id: fileId,
					entity_type: 'file',
					list_names: listNames,
					row_count: fetched.reduce((n, f) => n + f.rows.length, 0),
					ok: true,
				})
			})
			.catch((err) => {
				console.error('[view-refresh] refresh failed', err)
				// The rows already on screen stay; only the status says it did not work.
				setState((s) => ({ ...s, status: 'error' }))
				trackViewRefreshed({
					entity_id: fileId,
					entity_type: 'file',
					list_names: listNames,
					row_count: 0,
					ok: false,
				})
			})
			.finally(() => {
				inFlight.current = false
			})
	}, [workspaceId, fileId])

	return { ...state, answer, refresh }
}

function formatAge(ms: number): string {
	const minutes = Math.floor(ms / 60_000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes} min ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours} h ago`
	return `${Math.floor(hours / 24)} d ago`
}

function formatClock(epochMs: number): string {
	return new Date(epochMs).toLocaleString(undefined, {
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
	})
}

interface ViewRefreshBarProps {
	refresh: ViewRefresh
	/** When the file was last written, shown until the first Refresh. */
	fileUpdatedAt: number | null
	/** False when the view cannot be hosted (a deck, a frame that navigated away): the label is shown with no button. */
	canRefresh: boolean
}

/**
 * The line above a view that has list sources. It belongs to the app, not the file: the
 * label text is built here from times the app knows, so a view cannot write its own.
 */
export function ViewRefreshBar({ refresh, fileUpdatedAt, canRefresh }: ViewRefreshBarProps) {
	// Re-render once a minute so "2 h ago" and the amber state keep up with the clock.
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 60_000)
		return () => window.clearInterval(timer)
	}, [])

	const shownAt = refresh.fetchedAt ?? fileUpdatedAt
	const stale = shownAt !== null && now - shownAt > STALE_AFTER_MS
	const label = shownAt === null ? 'Not refreshed yet' : `Refreshed ${formatAge(now - shownAt)}`

	return (
		<div
			className="flex shrink-0 items-center justify-end gap-2 border-b border-border bg-background px-3 py-1 text-xs text-muted-foreground"
			aria-live="polite"
			data-testid="view-refresh-bar"
		>
			{refresh.status === 'error' ? (
				<span className="text-error">
					{shownAt === null
						? "Couldn't refresh."
						: `Couldn't refresh. Showing data from ${formatClock(shownAt)}`}
				</span>
			) : (
				<span className={cn(stale && 'text-warning')} data-stale={stale || undefined}>
					{label}
				</span>
			)}
			{canRefresh && (
				<Button
					type="button"
					variant="ghost"
					size="xs"
					disabled={refresh.status === 'loading'}
					onClick={refresh.refresh}
				>
					<RefreshCw
						className={cn('size-3', refresh.status === 'loading' && 'animate-spin')}
						aria-hidden="true"
					/>
					{refresh.status === 'loading'
						? 'Refreshing…'
						: refresh.status === 'error'
							? 'Try again'
							: 'Refresh'}
				</Button>
			)}
		</div>
	)
}
