import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAddToolBrokerIntegration, useToolBrokerCatalogInfinite } from '@/hooks/use-tool-broker'
import type { ToolBrokerCatalogEntry } from '@/lib/api'
import { Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

// Browse the catalogue and add an integration from it.
//
// Adding is all this does — it registers the integration for the workspace and
// the existing row takes over for connecting, so the OAuth, api-key and no-auth
// paths are the ones already built and tested rather than a second copy.

export function CatalogBrowser({
	open,
	onOpenChange,
	workspaceId,
}: { open: boolean; onOpenChange: (open: boolean) => void; workspaceId: string }) {
	const [query, setQuery] = useState('')
	const { data, isLoading, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } =
		useToolBrokerCatalogInfinite(workspaceId, query, open)
	const add = useAddToolBrokerIntegration(workspaceId)

	const entries = data?.pages.flatMap((page) => page.entries) ?? []
	const total = data?.pages[0]?.total ?? 0

	// A callback ref, not useRef: the dialog mounts its content only when opened,
	// so the sentinel appears LATER than the data does. With a plain ref nothing
	// re-runs the effect at that moment — it had already given up on a null node,
	// and hasNextPage was true well before the node existed, so no dependency
	// changed. Storing the node in state makes its arrival the trigger.
	const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
	const loadNextPage = useCallback(() => {
		void fetchNextPage()
	}, [fetchNextPage])

	useEffect(() => {
		// Stand down after a failed page: the sentinel is still on screen, so
		// re-observing would refire the same request in a tight loop.
		if (!sentinel || !hasNextPage || isFetchingNextPage || isFetchNextPageError) return
		if (typeof IntersectionObserver === 'undefined') return
		const observer = new IntersectionObserver(
			(observed) => {
				if (observed.some((entry) => entry.isIntersecting)) loadNextPage()
			},
			// Observed against the viewport, not the scroll container. The dialog
			// sizes to its content, so on a short list the container does not scroll
			// at all and a container-rooted observer never sees the sentinel move.
			// Fetch just before it is reached, so scrolling stays smooth rather than
			// stopping at the bottom and waiting.
			{ rootMargin: '200px' },
		)
		observer.observe(sentinel)
		return () => observer.disconnect()
	}, [sentinel, hasNextPage, isFetchingNextPage, isFetchNextPageError, loadNextPage])

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) setQuery('')
				onOpenChange(next)
			}}
		>
			<DialogContent className="flex max-h-[85dvh] flex-col">
				<DialogHeader>
					<DialogTitle>Browse integrations</DialogTitle>
					<DialogDescription>
						Every entry here has been verified by connecting to it. Adding one makes it available to
						this workspace; you connect it afterwards.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-1.5">
					<Label htmlFor="catalog-search">Search</Label>
					<Input
						id="catalog-search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Linear, Sentry, Stripe…"
						autoComplete="off"
					/>
				</div>

				{/* The list scrolls inside the dialog rather than growing it, so the
				    search field stays reachable on a phone. */}
				<div className="min-h-0 flex-1 overflow-y-auto">
					{isLoading ? (
						<ListSkeleton />
					) : !entries.length ? (
						<EmptyState
							icon={<Search className="size-5" />}
							title={query ? 'Nothing matches that' : 'The catalogue is empty'}
							description={
								query
									? 'Try a different name, or add the integration by URL instead.'
									: 'No integrations have been synced yet.'
							}
						/>
					) : (
						<ul className="space-y-2">
							{entries.map((entry) => (
								<CatalogRow
									key={entry.id}
									entry={entry}
									pending={add.isPending}
									onAdd={() =>
										add.mutate({
											url: entry.endpointUrl,
											kind: entry.connectKind,
											name: entry.name,
										})
									}
								/>
							))}
						</ul>
					)}

					{/* Inside the scroll container, so intersecting it means the reader
					    has actually reached the end of the list. */}
					<div ref={setSentinel} aria-hidden="true" className="h-px" />

					{isFetchingNextPage ? (
						<p className="py-3 text-center text-text-secondary text-xs">Loading more…</p>
					) : isFetchNextPageError ? (
						// The observer stands down on error, so this button is the only
						// way back in rather than a silent stall at the bottom.
						<div className="py-3 text-center">
							<Button size="sm" variant="outline" onClick={loadNextPage}>
								Try again
							</Button>
						</div>
					) : null}
				</div>

				{entries.length ? (
					<p className="text-text-secondary text-xs">
						{hasNextPage ? `${entries.length} of ${total}` : `All ${total}`}
						{query ? ' matching' : ''}
					</p>
				) : null}
			</DialogContent>
		</Dialog>
	)
}

function CatalogRow({
	entry,
	pending,
	onAdd,
}: { entry: ToolBrokerCatalogEntry; pending: boolean; onAdd: () => void }) {
	// Served from our own origin. An upstream icon URL here would put the
	// catalogue source's hostname in every page view.
	const iconSrc = entry.iconPath ? `/api/tool-broker/catalog/icons/${entry.domain}` : null

	// An entry whose provider will not register a client cannot be connected
	// without setup we have not built, so say that up front rather than letting
	// someone click Add and hit a refusal two steps later.
	const needsSetup = entry.authKind !== 'none' && !entry.supportsDcr

	return (
		<li className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
			<div className="flex min-w-0 items-center gap-3">
				{iconSrc ? (
					<img src={iconSrc} alt="" className="size-6 shrink-0 rounded" loading="lazy" />
				) : (
					<div className="size-6 shrink-0 rounded bg-muted" />
				)}
				<div className="min-w-0">
					<p className="truncate font-medium text-sm">{entry.name}</p>
					<p className="truncate text-text-secondary text-xs">
						{entry.description ?? entry.domain}
					</p>
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-2">
				{needsSetup ? (
					<span className="text-text-secondary text-xs">Needs setup</span>
				) : entry.authKind === 'none' ? (
					<span className="text-text-secondary text-xs">No sign-in</span>
				) : null}
				<Button size="sm" variant="outline" disabled={pending || needsSetup} onClick={onAdd}>
					Add
				</Button>
			</div>
		</li>
	)
}
