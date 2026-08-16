import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import type { ReactNode } from 'react'

export interface QueryLike<TData> {
	data: TData | undefined
	isLoading?: boolean
	isPending?: boolean
	isError: boolean
	error?: Error | null
	refetch?: () => void
}

interface QueryStateProps<TData> {
	query: QueryLike<TData>
	/** Loading UI. Defaults to `<ListSkeleton />` per the "skeleton blocks, not spinners" rule. */
	loading?: ReactNode
	/** Empty UI. When omitted, empty is treated as a resolved state and `children` is called with the data. */
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

	if (isLoading && query.data === undefined) return <>{loadingNode}</>
	if (query.isError && query.data === undefined) {
		return (
			<RouteError
				compact
				title={errorTitle}
				error={query.error ?? new Error('Unknown error')}
				onRetry={query.refetch}
			/>
		)
	}
	if (query.data === undefined) return <>{loadingNode}</>
	if (empty && isEmpty(query.data)) return <>{empty}</>
	return <>{children(query.data)}</>
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
