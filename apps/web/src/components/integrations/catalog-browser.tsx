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
import { useAddToolBrokerIntegration, useToolBrokerCatalog } from '@/hooks/use-tool-broker'
import type { ToolBrokerCatalogEntry } from '@/lib/api'
import { Search } from 'lucide-react'
import { useState } from 'react'

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
	const { data, isLoading } = useToolBrokerCatalog(workspaceId, query)
	const add = useAddToolBrokerIntegration(workspaceId)

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
					) : !data?.entries.length ? (
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
							{data.entries.map((entry) => (
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
				</div>

				{/* The list is capped server-side. Without this line the cap is
				    invisible, and a browser showing 50 of 578 reads as "that is
				    everything there is". */}
				{data && data.total > data.entries.length ? (
					<p className="text-text-secondary text-xs">
						Showing {data.entries.length} of {data.total}. Search to narrow it down.
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
