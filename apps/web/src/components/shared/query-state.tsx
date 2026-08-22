import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import type { ReactNode } from 'react'

export interface QueryLike<TData> {
	data: TData | undefined
	isLoading?: boolean
	isPending?: boolean
	isError: boolean
	error?: Error | null
	refetch?: () => void
	/** TanStack: `'idle'` for a disabled query, `'fetching'` while a request is open. */
	fetchStatus?: 'fetching' | 'paused' | 'idle'
}

interface QueryStateProps<TData> {
	query: QueryLike<TData>
	/** Loading UI. Defaults to `<ListSkeleton />` per the "skeleton blocks, not spinners" rule. */
	loading?: ReactNode
	/**
	 * Empty UI, also used when the query settles with no data at all. When
	 * omitted, an empty-but-defined `data` is treated as a resolved state and
	 * `children` is called with it; a resolved-`undefined` falls back to
	 * `<NotFoundState />`.
	 */
	empty?: ReactNode
	/** Custom emptiness check. Default: `undefined | null | []` is empty. */
	isEmpty?: (data: TData) => boolean
	/** Title on the inline error card. Default: "Couldn't load". */
	errorTitle?: string
	children: (data: TData) => ReactNode
}

function defaultIsEmpty(data: unknown): boolean {
	if (data == null) return true
	if (Array.isArray(data)) return data.length === 0
	return false
}

/**
 * Maps a TanStack Query result to the shared loading/error/empty vocabulary.
 * Renders `children(data)` once the query resolves with non-empty data.
 *
 * An error only replaces the content when there is nothing cached to show. Once
 * `data` exists, a failed refetch keeps the content and adds a stale-data notice
 * above it — cached data is never presented as if it were fresh.
 *
 * Offline state is handled globally by <OfflineBanner /> in the root layout.
 */
export function QueryState<TData>({
	query,
	loading,
	empty,
	isEmpty = defaultIsEmpty as (data: TData) => boolean,
	errorTitle = "Couldn't load",
	children,
}: QueryStateProps<TData>) {
	const isLoading = query.isLoading ?? query.isPending ?? false
	const loadingNode = loading ?? <ListSkeleton />
	// A query with no `fetchStatus` (a plain object in a test, or a caller passing
	// a hand-rolled shape) falls back to `isLoading` as the in-flight signal.
	const isFetching = query.fetchStatus ? query.fetchStatus === 'fetching' : isLoading

	if (query.data === undefined) {
		if (query.isError) {
			return (
				<RouteError
					compact
					title={errorTitle}
					error={query.error ?? new Error('Unknown error')}
					onRetry={query.refetch}
				/>
			)
		}
		if (isLoading || isFetching) return <>{loadingNode}</>
		// Settled (or disabled) with nothing to show. Rendering the skeleton here
		// would hang forever with a clean console and a clean network tab, so a
		// resolved-undefined query resolves to the empty vocabulary instead.
		return <>{empty ?? <NotFoundState />}</>
	}

	// Data is cached but the latest fetch failed — a background refetch, an SSE
	// invalidation, a post-mutation refetch, a reconnect. Showing it bare would
	// present a stale snapshot as if it were fresh, so the content stays (it is
	// still the best available) under a persistent notice with a retry.
	const body = empty && isEmpty(query.data) ? <>{empty}</> : <>{children(query.data)}</>
	if (!query.isError) return body

	return (
		<>
			<StaleDataNotice onRetry={query.refetch} />
			{body}
		</>
	)
}

/**
 * Persistent strip shown above cached content whose latest refetch failed.
 * Deliberately not dismissable — the staleness lasts until a fetch succeeds.
 */
function StaleDataNotice({ onRetry }: { onRetry?: () => void }) {
	return (
		<output className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-muted px-3 py-2">
			<p className="text-xs text-muted-foreground">
				Showing the last loaded data &mdash; couldn&rsquo;t refresh.
			</p>
			{onRetry && (
				<Button variant="outline" size="sm" onClick={onRetry} className="h-7 text-xs">
					Try again
				</Button>
			)}
		</output>
	)
}

/**
 * Inline "couldn't load" card for cases where a route composes its own state
 * machine but still wants the shared error UI (e.g. a panel next to other content).
 */
export function QueryStateError({
	error,
	title = "Couldn't load",
	onRetry,
	className,
}: {
	error: Error | null | undefined
	title?: string
	onRetry?: () => void
	className?: string
}) {
	return (
		<RouteError
			compact
			title={title}
			error={error ?? new Error('Unknown error')}
			onRetry={onRetry}
			className={className}
		/>
	)
}

/**
 * Inline "not found" empty state for detail routes when the fetch returned no
 * resource (either 404 or the id is stale). Distinct from `<EmptyState />` at
 * the call site so intent is legible.
 */
export function NotFoundState({
	title = 'Not found',
	description = "This item may have been deleted, or you don't have access to it.",
}: {
	title?: string
	description?: string
}) {
	return <EmptyState title={title} description={description} />
}
