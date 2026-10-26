import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { Button } from '@/components/ui/button'
import type { EmptyExplanation, WordHit } from '@/lib/search/empty-state'
import { WifiOff } from 'lucide-react'

// First load, nothing earlier to show: six rows the height of a result.
export function ResultsSkeleton() {
	return (
		<div aria-busy="true" className="flex flex-col gap-0.5 px-3 pt-3 md:px-5">
			{Array.from({ length: 6 }).map((_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows never reorder
				<div key={i} className="flex h-[52px] items-center gap-[11px] px-3">
					<Skeleton className="size-[22px] shrink-0 rounded-md motion-reduce:animate-none" />
					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<Skeleton className="h-3 w-[55%] motion-reduce:animate-none" />
						<Skeleton className="h-2.5 w-[30%] motion-reduce:animate-none" />
					</div>
				</div>
			))}
		</div>
	)
}

// The search itself failed. The field and chips stay as they are; only the list is replaced.
export function ResultsError({
	offline,
	onRetry,
}: {
	offline: boolean
	onRetry: () => void
}) {
	return (
		<div role="alert" className="px-3 py-8 text-center md:px-5">
			<p className="text-sm font-medium text-foreground">
				{offline ? "You're offline" : "Couldn't run that search"}
			</p>
			<p className="mt-1 text-xs text-muted-foreground">
				{offline ? 'Reconnect to search.' : 'Your filters are kept. Try again in a moment.'}
			</p>
			<Button
				variant="outline"
				size="sm"
				className="mt-3 max-[1024.02px]:min-h-11"
				disabled={offline}
				onClick={onRetry}
			>
				Retry
			</Button>
		</div>
	)
}

export function OfflineNotice() {
	return (
		<output className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
			<WifiOff aria-hidden="true" className="size-3.5" />
			You're offline. These results may be out of date.
		</output>
	)
}

export function SlowNotice() {
	return (
		<output className="block text-[11.5px] text-muted-foreground">
			Still searching. Results may be incomplete.
		</output>
	)
}

export function PartialNotice({ onRetry }: { onRetry: () => void }) {
	return (
		<p className="text-[11.5px] text-muted-foreground">
			Some results couldn't be loaded, so these counts may be incomplete.{' '}
			<button
				type="button"
				onClick={onRetry}
				className="underline underline-offset-2 hover:text-foreground"
			>
				Retry
			</button>
		</p>
	)
}

export function CapNotice({ shown, total }: { shown: number; total: number }) {
	return (
		<p className="px-3 pb-8 text-[11.5px] text-muted-foreground md:px-5">
			Showing {shown} of {total}. Add a filter to narrow the list.
		</p>
	)
}

interface EmptyResultsProps {
	explanation: EmptyExplanation
	/** The words, shown in the "Search in everything" button. */
	query: string
	onApplyWord: (hit: WordHit) => void
	onClearFilters: () => void
}

// Nothing matched. Say why in words: a type or status word the person typed is
// named and offered as a chip, and a filter that emptied the list can be cleared
// or widened to everything.
export function EmptyResults({
	explanation,
	query,
	onApplyWord,
	onClearFilters,
}: EmptyResultsProps) {
	const { title, wordNotes, hits, filtered, withoutStatuses, everything } = explanation
	return (
		<div className="flex flex-col items-center px-3 md:px-5">
			<EmptyState
				emphasis="page"
				title={title}
				description={
					[
						...wordNotes,
						withoutStatuses !== null && withoutStatuses > 0
							? `Clearing the status filter would give ${withoutStatuses} result${withoutStatuses === 1 ? '' : 's'}.`
							: '',
					]
						.filter(Boolean)
						.join(' ') ||
					'Search looks across chats, loops, agents, objects and automations. Try a shorter word.'
				}
				action={
					<div className="flex flex-col items-center gap-3">
						{hits.length > 0 ? (
							<div className="flex flex-wrap items-center justify-center gap-2">
								{hits.map((hit) => (
									<Button
										key={`${hit.kind}:${hit.value}`}
										type="button"
										variant="outline"
										size="sm"
										className="rounded-full max-[1024.02px]:min-h-11"
										onClick={() => onApplyWord(hit)}
									>
										Filter by {hit.label}
									</Button>
								))}
							</div>
						) : null}
						{filtered ? (
							<div className="flex flex-wrap items-center justify-center gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="max-[1024.02px]:min-h-11"
									onClick={onClearFilters}
								>
									Clear filters
								</Button>
								{everything > 0 && query ? (
									<Button
										type="button"
										size="sm"
										className="max-[1024.02px]:min-h-11"
										onClick={onClearFilters}
									>
										Search “{query}” in everything · {everything} result
										{everything === 1 ? '' : 's'}
									</Button>
								) : null}
							</div>
						) : null}
					</div>
				}
			/>
		</div>
	)
}
